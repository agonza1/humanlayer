import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, watch } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import { canonicalReviewValue } from '@humanlayer/riptide-api-contract/lib/review-progression'
import {
	ReviewHandoffSchema,
	mergeOutcomeIdentity,
	reviewReportStatus,
	type ReviewHandoff,
} from '@humanlayer/riptide-api-contract/lib/review-reporting'
import z from 'zod/v4'

import type { ORPCClient } from '@/agents/claudecode/types'

export const reportDigest = (value: unknown) => createHash('sha256').update(canonicalReviewValue(value)).digest('hex')
const bytesDigest = (value: string) => createHash('sha256').update(value).digest('hex')
export const reportRequestId = (request: Omit<ReviewHandoff, 'requestId'> | ReviewHandoff) =>
	reportDigest({
		enrollmentId: request.enrollmentId,
		outcomeKey: request.outcomeKey,
		repository: request.repository,
		pr: request.pr,
		headSha: request.headSha,
		scopeSha256: request.scopeSha256,
	})
const receiptId = (request: ReviewHandoff, slot: string) => {
	const hex = reportDigest({ requestId: request.requestId, slot })
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export type ReportTransport = {
	directory: string
	requiredReturns: Array<'origin_session' | 'artifact'>
	submit: (value: unknown, signal: AbortSignal) => Promise<unknown>
}
type ReportOutcome = {
	status: string
	reason: string
	context?: { pr: number | null; headSha: string | null } | null
}
export type ReviewCoordinatorUncertainty =
	| 'review_writer_identity_unknown'
	| 'review_prior_helper_unknown'
	| 'review_helper_state_unknown'
function outcomeRequest(snapshot: ReviewProgressionSnapshot, outcome: ReportOutcome): ReviewHandoff | null {
	if (
		!['ready_for_human_approval', 'needs_decision'].includes(outcome.status) ||
		!snapshot.verifiedBinding ||
		!snapshot.scopeSha256
	)
		return null
	const outcomeKey = reportDigest({
		head_sha: outcome.context?.headSha ?? null,
		scope_sha256: snapshot.scopeSha256,
		status: outcome.status,
		reason: outcome.reason,
	})
	const fields = {
		version: 1 as const,
		kind: outcome.status === 'ready_for_human_approval' ? ('readiness' as const) : ('blocker' as const),
		enrollmentId: snapshot.enrollment.enrollmentId,
		outcomeKey,
		repository: snapshot.verifiedBinding.repository,
		pr: outcome.context?.pr ?? null,
		headSha: outcome.context?.headSha ?? null,
		scopeSha256: snapshot.scopeSha256,
		evidenceRef: outcomeKey,
	}
	return ReviewHandoffSchema.parse({ ...fields, requestId: reportRequestId(fields) })
}
const resultSchema = z.strictObject({
	version: z.literal(1),
	transportKey: z.string().regex(/^[0-9a-f]{64}$/),
	requestId: z.string(),
	outcomeKey: z.string(),
	status: z.enum(['delivered', 'failed', 'unknown']),
	slackReceipt: z.string().nullable(),
	contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
	report: z.string().max(40000).optional(),
	compacted: z.literal(true).optional(),
	reportDigest: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
})
export async function privateReportFile(path: string): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const info = await file.stat()
		if (
			!info.isFile() ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o777) !== 0o600 ||
			info.nlink !== 1 ||
			info.size > 65536
		)
			throw new Error('review_report_file')
		const bytes = Buffer.alloc(65537)
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
		if (bytesRead > 65536) throw new Error('review_report_size')
		return bytes.subarray(0, bytesRead)
	} finally {
		await file.close()
	}
}
export function submitReviewTransport(
	path: string,
	environment: Record<string, string>,
	value: unknown,
	signal: AbortSignal,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path], {
			shell: false,
			env: Object.fromEntries(
				Object.entries({ ...process.env, ...environment }).filter(([key]) => !key.startsWith('SLACK_')),
			),
			stdio: ['pipe', 'pipe', 'pipe'],
			signal,
		})
		let stdout = '',
			stderrBytes = 0,
			failed = false
		const timer = setTimeout(() => {
			failed = true
			child.kill()
		}, 10000)
		child.stdout.on('data', (bytes: Buffer) => {
			stdout += bytes.toString('utf8')
			if (Buffer.byteLength(stdout) > 65536) {
				failed = true
				child.kill()
			}
		})
		child.stderr.on('data', (bytes: Buffer) => {
			stderrBytes += bytes.length
			if (stderrBytes > 65536) {
				failed = true
				child.kill()
			}
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			try {
				if (failed || code !== 0) throw new Error('review_submit_unknown')
				resolve(JSON.parse(stdout))
			} catch {
				reject(new Error('review_submit_unknown'))
			}
		})
		child.stdin.on('error', () => undefined)
		child.stdin.end(canonicalReviewValue(value))
	})
}

export function makeReviewReporting(
	api: ORPCClient,
	resolveTransport: (snapshot: ReviewProgressionSnapshot) => Promise<ReportTransport | null>,
	attention: (taskId: string) => void,
	enabled: (taskId: string) => Promise<boolean> = async () => true,
	coordinatorUncertainty: (taskId: string) => ReviewCoordinatorUncertainty | null = () => null,
) {
	const tasks = new Map<
		string,
		{
			active?: Promise<void>
			timer?: ReturnType<typeof setTimeout>
			watcher?: ReturnType<typeof watch>
			controller: AbortController
			dirty?: boolean
		}
	>()
	let stopped = false
	const reconcile = async (taskId: string, entry: NonNullable<ReturnType<typeof tasks.get>>) => {
		const signal = entry.controller.signal
		if (!(await enabled(taskId))) {
			entry.watcher?.close()
			entry.watcher = undefined
			return false
		}
		const state = await api.reviewProgression.reports({ taskId }, { signal })
		const snapshot = state.snapshot,
			transport = await resolveTransport(snapshot)
		if (!transport) {
			entry.watcher?.close()
			entry.watcher = undefined
			return false
		}
		const info = await stat(transport.directory)
		if (
			(await realpath(transport.directory)) !== transport.directory ||
			!info.isDirectory() ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o777) !== 0o700
		)
			throw new Error('review_report_directory')
		if (!entry.watcher) {
			entry.watcher = watch(transport.directory, { persistent: false }, (_event, name) => {
				if (name && /^[0-9a-f]{64}\.(request|result)\.json$/.test(name.toString())) schedule(taskId)
			})
			entry.watcher.on('error', () => {
				entry.watcher?.close()
				entry.watcher = undefined
				attention(taskId)
			})
		}
		const uncertainty = coordinatorUncertainty(taskId)
		const outcome = uncertainty
			? { status: 'needs_decision', reason: uncertainty, context: null }
			: state.planningSuspended === false
				? state.outcome
				: null
		const requestForOutcome = outcome ? outcomeRequest(snapshot, outcome) : null
		let pending = false
		if (requestForOutcome) {
			const { requestId } = requestForOutcome
			if (
				!transport.requiredReturns.every((slot) =>
					state.receipts.some(
						(receipt) => receipt.requestId === requestId && receipt.destinationSlot === slot,
					),
				)
			) {
				try {
					await ensureRequest(transport, requestForOutcome, signal)
				} catch {
					pending = true
					attention(taskId)
				}
			}
		}
		const names = (await readdir(transport.directory))
			.filter((name) => /^[0-9a-f]{64}\.request\.json$/.test(name))
			.sort()
		if (names.length > 16384) throw new Error('review_report_capacity')
		for (const name of names) {
			if (signal.aborted) return false
			let raw: unknown
			try {
				raw = JSON.parse((await privateReportFile(join(transport.directory, name))).toString('utf8'))
			} catch {
				continue
			}
			const parsed = ReviewHandoffSchema.safeParse(raw)
			if (!parsed.success) continue
			const request = parsed.data
			if (
				name !== `${request.requestId}.request.json` ||
				request.requestId !== reportRequestId(request) ||
				request.enrollmentId !== snapshot.enrollment.enrollmentId ||
				request.repository !== snapshot.verifiedBinding?.repository ||
				request.scopeSha256 !== snapshot.scopeSha256
			)
				continue
			if (request.kind === 'merge_result' && request.outcomeKey !== reportDigest(mergeOutcomeIdentity(request)))
				throw new Error('review_merge_outcome_binding')
			let result: z.infer<typeof resultSchema>
			try {
				result = resultSchema.parse(
					JSON.parse(
						(
							await privateReportFile(join(transport.directory, `${request.requestId}.result.json`))
						).toString('utf8'),
					),
				)
			} catch {
				pending = true
				continue
			}
			if (
				result.requestId !== request.requestId ||
				result.transportKey !== request.requestId ||
				result.outcomeKey !== request.outcomeKey
			)
				throw new Error('review_report_binding')
			for (const destinationSlot of transport.requiredReturns) {
				try {
					let receipt = state.receipts.find(
						(item) => item.requestId === request.requestId && item.destinationSlot === destinationSlot,
					)
					if (!receipt) {
						if (result.compacted || typeof result.report !== 'string')
							throw new Error('review_report_compacted_without_receipt')
						let id = receiptId(request, destinationSlot)
						const content =
							destinationSlot === 'origin_session'
								? canonicalReviewValue({
										kind: 'review_progression',
										version: 1,
										outcomeKey: request.outcomeKey,
										status: reviewReportStatus(request, result.status),
										repository: request.repository,
										pr: request.pr,
										headSha: request.headSha,
										reportArtifact: `review-report-${request.outcomeKey}.md`,
									})
								: `# Review report\n\n${canonicalReviewValue(request)}\n\n${result.report}\n\nSlack delivery: ${result.status}. Slack receipt: ${result.slackReceipt ?? 'not confirmed'}. Origin-session and artifact receipts are verified independently.\n`
						if (destinationSlot === 'origin_session') {
							if (!state.codingAgentSessionId) throw new Error('review_origin_sender_unavailable')
							await api.sessions.events.create(
								{
									eventId: id,
									sessionId: snapshot.sourceSessionId,
									codingAgentSessionId: state.codingAgentSessionId,
									eventType: 'system',
									role: 'system',
									content,
								},
								{ signal },
							)
						} else {
							const actual = await api.artifacts.upsert(
								{
									id,
									taskId,
									fileName: `review-report-${request.outcomeKey}.md`,
									content,
									ifExists: 'match',
								},
								{ signal },
							)
							id = z.uuid().parse(actual.artifactId)
						}
						const retained = await api.reviewProgression.recordDelivery(
							{
								kind: 'return_receipt',
								taskId,
								sourceSessionId: snapshot.sourceSessionId,
								request,
								deliveryStatus: result.status,
								destinationSlot,
								receiptIdentity: id,
								contentDigest: bytesDigest(content),
							},
							{ signal },
						)
						if (
							!('destinationSlot' in retained) ||
							retained.requestId !== request.requestId ||
							retained.destinationSlot !== destinationSlot ||
							retained.receiptIdentity !== id ||
							retained.contentDigest !== bytesDigest(content)
						)
							throw new Error('review_return_receipt')
						receipt = retained
					}
					const fields = {
						version: 1,
						kind: 'return_ack',
						enrollmentId: request.enrollmentId,
						requestId: request.requestId,
						outcomeKey: request.outcomeKey,
						destinationSlot,
						receiptIdentity: receipt.receiptIdentity,
						contentDigest: receipt.contentDigest,
					}
					const acknowledgementDigest = reportDigest(fields)
					const acknowledgement = (await transport.submit({ ...fields, acknowledgementDigest }, signal)) as {
						status?: string
						acknowledgementDigest?: string
						requestId?: string
						outcomeKey?: string
					}
					if (
						acknowledgement.status !== 'acknowledged' ||
						acknowledgement.acknowledgementDigest !== acknowledgementDigest ||
						acknowledgement.requestId !== request.requestId ||
						acknowledgement.outcomeKey !== request.outcomeKey
					)
						pending = true
				} catch {
					pending = true
					attention(taskId)
				}
			}
		}
		return pending
	}
	const schedule = (taskId: string) => {
		if (stopped) return
		let entry = tasks.get(taskId)
		if (!entry) {
			if (tasks.size >= 256) {
				attention(taskId)
				return
			}
			entry = { controller: new AbortController() }
			tasks.set(taskId, entry)
		}
		if (entry.active) {
			entry.dirty = true
			return
		}
		clearTimeout(entry.timer)
		const slot = entry
		slot.active = reconcile(taskId, slot)
			.catch(() => {
				attention(taskId)
				return true
			})
			.then((pending) => {
				if (pending && !stopped && !slot.controller.signal.aborted) {
					slot.timer = setTimeout(() => schedule(taskId), 1000)
					slot.timer.unref?.()
				}
			})
			.finally(() => {
				slot.active = undefined
				if (slot.dirty && !stopped && !slot.controller.signal.aborted) {
					slot.dirty = false
					schedule(taskId)
				}
			})
	}
	return {
		async retain(
			this: void,
			snapshot: ReviewProgressionSnapshot,
			outcome: ReportOutcome,
			signal: AbortSignal,
			expectedWakeRevision?: string,
		) {
			const request = outcomeRequest(snapshot, outcome)
			if (!request) return
			if (outcome.status === 'ready_for_human_approval' && expectedWakeRevision === undefined) return
			const current = await api.reviewProgression.reports({ taskId: snapshot.taskId }, { signal })
			if (
				current.planningSuspended !== false ||
				(expectedWakeRevision !== undefined && current.wakeRevision !== expectedWakeRevision) ||
				canonicalReviewValue(current.snapshot) !== canonicalReviewValue(snapshot)
			)
				return
			const transport = await resolveTransport(snapshot)
			if (!transport) return
			await ensureRequest(transport, request, signal)
		},
		update: (row: { task_id: string }) => schedule(row.task_id),
		remove(taskId: string) {
			const entry = tasks.get(taskId)
			if (entry) {
				entry.controller.abort()
				clearTimeout(entry.timer)
				entry.watcher?.close()
				tasks.delete(taskId)
			}
		},
		async flush(taskId: string) {
			schedule(taskId)
			await tasks.get(taskId)?.active
		},
		async stop() {
			stopped = true
			for (const entry of tasks.values()) {
				clearTimeout(entry.timer)
				entry.watcher?.close()
				entry.controller.abort()
			}
			await Promise.all([...tasks.values()].flatMap((entry) => (entry.active ? [entry.active] : [])))
			tasks.clear()
		},
	}
}

async function ensureRequest(transport: ReportTransport, request: ReviewHandoff, signal: AbortSignal) {
	const path = join(transport.directory, `${request.requestId}.request.json`)
	let bytes: Buffer
	try {
		bytes = await privateReportFile(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		await transport.submit(request, signal)
		bytes = await privateReportFile(path)
	}
	if (canonicalReviewValue(JSON.parse(bytes.toString('utf8'))) !== canonicalReviewValue(request))
		throw new Error('review_report_not_retained')
}

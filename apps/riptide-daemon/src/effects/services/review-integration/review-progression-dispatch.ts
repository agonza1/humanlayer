import { createHash } from 'node:crypto'

import { reviewProgressionSelectSchema } from '@humanlayer/db/tables/review-progression'
import { ReviewContinuationSchema, ReviewOutcomeSchema } from '@humanlayer/db/zodschemas/review-progression'
import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import { canonicalReviewValue } from '@humanlayer/riptide-api-contract/lib/review-progression'
import { Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import z from 'zod/v4'

import type { ReviewLocalEnrollment } from './review-integration'

export type ReviewProgressionRow = z.infer<typeof reviewProgressionSelectSchema>
export const reviewResultDigest = (value: unknown) =>
	createHash('sha256').update(canonicalReviewValue(value)).digest('hex')
export interface ReviewDispatchClock {
	now(): number
	set(delay: number, callback: () => void): unknown
	clear(timer: unknown): void
}
const clock: ReviewDispatchClock = {
	now: Date.now,
	set: (delay, callback) => setTimeout(callback, delay),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** A host-local scheduling cache, never launch authority. Every run conditionally claims fresh API data. */
export function makeReviewProgressionDispatch(options: {
	run(row: ReviewProgressionRow, signal: AbortSignal): Promise<void>
	attention(taskId: string): void
	clock?: ReviewDispatchClock
	concurrency?: number
}) {
	const time = options.clock ?? clock
	type Entry = {
		row: ReviewProgressionRow
		key: string
		attempted?: string
		running: boolean
		deleted: boolean
		controller?: AbortController
		timer?: unknown
		local: number
	}
	const entries = new Map<string, Entry>()
	const keyFor = (entry: Entry) =>
		`${entry.row.wake_revision}:${entry.row.consumed_revision}:${canonicalReviewValue(entry.row.continuation)}:${entry.local}`
	const controllers = new Set<AbortController>()
	const completions = new Set<Promise<void>>()
	let stopped = false
	let active = 0
	const cancel = (entry: Entry) => {
		if (entry.timer !== undefined) time.clear(entry.timer)
		entry.timer = undefined
	}
	const due = (entry: Entry) =>
		!entry.row.planning_suspended &&
		(entry.row.wake_revision > entry.row.consumed_revision ||
			entry.row.continuation.kind === 'reconcile' ||
			(entry.row.next_wake_at !== null && entry.row.next_wake_at <= BigInt(time.now())))
	const drain = () => {
		if (stopped) return
		for (const [taskId, entry] of entries) {
			if (active >= (options.concurrency ?? 2)) break
			if (entry.running || entry.attempted === entry.key || !due(entry)) continue
			cancel(entry)
			entry.running = true
			entry.attempted = entry.key
			active++
			const controller = new AbortController()
			entry.controller = controller
			const candidate = entry.row
			controllers.add(controller)
			const completion = Promise.resolve()
				.then(() => options.run(candidate, controller.signal))
				.catch(() => {
					if (!stopped) options.attention(taskId)
				})
				.finally(() => {
					entry.running = false
					entry.controller = undefined
					if (entry.deleted) entries.delete(taskId)
					active--
					controllers.delete(controller)
					completions.delete(completion)
					drain()
				})
			completions.add(completion)
		}
	}
	const arm = (entry: Entry) => {
		cancel(entry)
		if (stopped || entry.row.planning_suspended || entry.row.next_wake_at === null || due(entry)) return
		const deadline = Number(entry.row.next_wake_at)
		if (!Number.isSafeInteger(deadline)) return
		entry.timer = time.set(Math.min(2_147_483_647, Math.max(0, deadline - time.now())), () => {
			entry.timer = undefined
			if (time.now() < deadline) return arm(entry)
			drain()
		})
	}
	return {
		update(this: void, input: ReviewProgressionRow) {
			if (stopped) return
			const row = reviewProgressionSelectSchema.parse(input)
			const previous = entries.get(row.task_id)
			if (previous && row.wake_revision < previous.row.wake_revision) return
			if (
				previous &&
				(row.consumed_revision < previous.row.consumed_revision ||
					row.claim_generation < previous.row.claim_generation)
			)
				return
			if (
				previous?.row.last_ack &&
				(!row.last_ack || BigInt(row.last_ack.generation) < BigInt(previous.row.last_ack.generation))
			)
				return
			if (!previous && entries.size >= 256) return options.attention(row.task_id)
			const entry = previous ?? { row, key: '', running: false, local: 0, deleted: false }
			if (entry.deleted) entry.local++
			entry.deleted = false
			entry.row = row
			// Claims, renewals and timestamps do not reset a pending policy deadline or retrigger work.
			entry.key = keyFor(entry)
			entries.set(row.task_id, entry)
			arm(entry)
			drain()
		},
		writerFinished(this: void, taskId: string) {
			const entry = entries.get(taskId)
			if (!entry || stopped) return
			entry.local++
			entry.key = keyFor(entry)
			// A real completion may follow Electric's semantic wake. It does not invent a deadline.
			drain()
		},
		remove(this: void, taskId: string) {
			const entry = entries.get(taskId)
			if (!entry) return
			cancel(entry)
			entry.deleted = true
			entry.controller?.abort()
			if (!entry.running) entries.delete(taskId)
		},
		async stop() {
			stopped = true
			for (const entry of entries.values()) cancel(entry)
			for (const controller of controllers) controller.abort()
			await Promise.allSettled([...completions])
			entries.clear()
		},
	}
}

const text = (maximum: number) => z.string().min(1).max(maximum)
const sha = z.string().regex(/^[0-9a-f]{64}$/)
const head = z.string().regex(/^[0-9a-f]{40}$/)
const pr = z.number().int().positive().max(2_147_483_647)
const context = z.strictObject({
	repository: text(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	taskId: z.uuid(),
	scopeSha256: sha.nullable(),
	pr: pr.nullable(),
	headSha: head.nullable(),
})
const finding = z.strictObject({
	id: text(256),
	severity: text(256),
	scope: text(256),
	disposition: text(256),
	evidence: text(4000),
	blocking: z.boolean().optional(),
})
const machine = z.strictObject({
	outputVersion: z.literal(1),
	context: context.nullable(),
	continuation: ReviewContinuationSchema,
	result: z.strictObject({
		status: z.enum(['plan_qa', 'plan_coder', 'plan_main', ...ReviewOutcomeSchema.shape.status.options]),
		reason: ReviewOutcomeSchema.shape.reason,
		repository: context.shape.repository.optional(),
		pr: pr.optional(),
		issue: pr.nullable().optional(),
		task_id: z.uuid().optional(),
		head_sha: head.optional(),
		scope_sha256: sha.optional(),
		url: text(1000).optional(),
		passes: z.number().int().min(0).max(3).optional(),
		rounds: z.number().int().min(0).max(2).optional(),
		verified: z.literal(true).optional(),
		readiness: z
			.strictObject({
				acceptance: z.literal('satisfied'),
				checks: z.enum(['satisfied', 'not_required']),
				qa: z.enum(['satisfied', 'not_required']),
			})
			.optional(),
		remaining_findings: z.array(finding).max(100).optional(),
	}),
	notification: z
		.strictObject({ requestId: sha, state: z.enum(['pending', 'delivered', 'failed', 'unknown']) })
		.optional(),
})

/** JSON.parse alone accepts duplicate keys and rounded/non-finite numbers. Scan before schema decoding. */
export function strictReviewJson(content: string): unknown {
	if (Buffer.byteLength(content) > 1_048_576) throw new Error('review_output_limit')
	let offset = 0
	const token =
		/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/y
	const next = (): string => {
		while (/\s/.test(content[offset] ?? '') && offset < content.length) offset++
		token.lastIndex = offset
		const match = token.exec(content)
		if (!match) throw new Error('invalid_review_json')
		offset = token.lastIndex
		return match[0]
	}
	const value = (item: string, depth: number): void => {
		if (depth > 64) throw new Error('review_json_depth')
		if (item === '{' || item === '[') {
			const closing = item === '{' ? '}' : ']'
			const keys = new Set<string>()
			let current = next()
			if (current === closing) return
			for (;;) {
				if (item === '{') {
					if (!current.startsWith('"')) throw new Error('invalid_review_json')
					const key = JSON.parse(current) as string
					if (keys.has(key) || next() !== ':') throw new Error('duplicate_review_key')
					keys.add(key)
					current = next()
				}
				value(current, depth + 1)
				const separator = next()
				if (separator === closing) return
				if (separator !== ',') throw new Error('invalid_review_json')
				current = next()
			}
		} else if (
			!item.startsWith('"') &&
			!['true', 'false', 'null'].includes(item) &&
			(!Number.isFinite(Number(item)) || !/^-?\d/.test(item))
		)
			throw new Error('invalid_review_json')
	}
	value(next(), 0)
	if (content.slice(offset).trim() !== '') throw new Error('trailing_review_json')
	return JSON.parse(content)
}

export function decodeReviewHelper(
	content: string,
	exitCode: number,
	expected: { repository: string; taskId: string; scopeSha256: string; pr?: number | null },
) {
	const output = machine.parse(strictReviewJson(content))
	const { result, continuation, context: binding } = output
	const reject = () => {
		throw new Error('unverified_review_outcome')
	}
	if (exitCode !== (result.status === 'needs_decision' ? 2 : 0)) reject()
	if (binding === null) {
		if (
			result.status !== 'needs_decision' ||
			continuation.kind !== 'stop' ||
			Object.keys(result).length !== 2 ||
			output.notification
		)
			reject()
		return output
	}
	if (
		Object.entries(expected).some(
			([key, value]) => value !== undefined && binding[key as keyof typeof binding] !== value,
		) ||
		(binding.pr === null) !== (binding.headSha === null)
	)
		reject()
	for (const [key, bound] of [
		['repository', 'repository'],
		['pr', 'pr'],
		['task_id', 'taskId'],
		['head_sha', 'headSha'],
		['scope_sha256', 'scopeSha256'],
	] as const)
		if (key in result && result[key] !== binding[bound]) reject()
	if (result.url && result.url !== `https://github.com/${binding.repository}/pull/${binding.pr}`) reject()
	if (
		!['waiting_writer', 'needs_decision'].includes(result.status) &&
		(binding.pr === null ||
			['repository', 'pr', 'task_id', 'head_sha', 'scope_sha256'].some((key) => !(key in result)))
	)
		reject()
	if (['waiting_writer', 'waiting_review'].includes(result.status) !== (continuation.kind === 'wait')) reject()
	if (result.status === 'waiting_writer' && continuation.kind === 'wait' && !continuation.actionId) reject()
	if (continuation.kind === 'reconcile' && !['reviewed', 'repaired'].includes(result.status)) reject()
	if (
		output.notification &&
		(binding.pr === null || !['ready_for_human_approval', 'needs_decision'].includes(result.status))
	)
		reject()
	if (result.status === 'ready_for_human_approval') {
		if (
			!result.verified ||
			!result.readiness ||
			!result.remaining_findings ||
			continuation.kind !== 'stop' ||
			new Set(result.remaining_findings.map((item) => item.id)).size !== result.remaining_findings.length ||
			result.remaining_findings.some(
				(item) =>
					item.disposition !== 'nonblocking' || item.blocking || !['P2', 'P3', 'P4'].includes(item.severity),
			)
		)
			reject()
	} else if (result.verified || result.readiness || result.remaining_findings) reject()
	return output
}

export function invokeReviewHelper(input: {
	snapshot: ReviewProgressionSnapshot
	enrollment: ReviewLocalEnrollment
	pr: number | null
	operation: 'observe-delivery' | 'step' | 'inspect-readiness'
	apply: boolean
	started(pid: number): void
	exited(pid: number): void
}) {
	return Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const bytes = new TextEncoder().encode(
				canonicalReviewValue({
					version: 1,
					snapshot: input.snapshot,
					enrollment: input.enrollment,
					pr: input.pr,
				}),
			)
			if (bytes.byteLength > 1_048_576 || (input.apply && input.operation !== 'step'))
				return yield* Effect.fail(new Error('invalid_review_invocation'))
			const argv = [
				'-B',
				input.enrollment.helper.path,
				'--config',
				input.enrollment.helperConfig.path,
				'--operation',
				input.operation,
				'--machine-output',
				'v1',
				'--managed-input',
				'v1',
			]
			if (input.apply) argv.push('--apply')
			const handle = yield* spawner.spawn(
				ChildProcess.make('python3', argv, {
					cwd: input.snapshot.workingDirectory,
					stdin: Stream.make(bytes),
					extendEnv: true,
					killSignal: 'SIGKILL',
				}),
			)
			input.started(handle.pid)
			const collect = (stream: typeof handle.stdout, retain: boolean, maximum: number) =>
				Effect.gen(function* () {
					const decoder = new TextDecoder('utf-8', { fatal: true })
					let size = 0
					let result = ''
					yield* Stream.runForEach(stream, (chunk) =>
						Effect.try(() => {
							size += chunk.byteLength
							if (size > maximum) throw new Error('review_output_limit')
							if (retain) result += decoder.decode(chunk, { stream: true })
						}),
					)
					return yield* Effect.try(() => (retain ? result + decoder.decode() : ''))
				})
			const result = yield* Effect.all(
				{
					stdout: collect(handle.stdout, true, 1_048_576),
					stderr: collect(handle.stderr, false, 65_536),
					exitCode: handle.exitCode.pipe(Effect.tap(() => Effect.sync(() => input.exited(handle.pid)))),
				},
				{ concurrency: 'unbounded' },
			)
			if (yield* handle.isRunning) return yield* Effect.fail(new Error('review_helper_still_running'))
			return { stdout: result.stdout, exitCode: Number(result.exitCode) }
		}).pipe(Effect.timeout('120 seconds')),
	).pipe(Effect.mapError(() => new Error('review_helper_state_unknown')))
}

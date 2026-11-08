import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { ReviewOutcomeSchema } from '@humanlayer/db/zodschemas/review-progression'
import {
	ReviewProgressionAdmissionSchema,
	ReviewClaimResultSchema,
	type ReviewProgressionSnapshot,
} from '@humanlayer/riptide-api-contract/daemon/review-progression'
import {
	canonicalReviewValue,
	reviewExecutionPayload,
	type ReviewExecutionSession,
	reviewHelperScope,
	reviewDeliveryContext,
	reviewDeliveryContextFile,
	ReviewProgressionBindingSchema,
	ReviewProgressionDigestSchema,
	ReviewProgressionReferenceSchema,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { Effect } from 'effect'
import { hash as artifactHash } from 'ohash'
import z from 'zod/v4'

import type { ORPCClient } from '@/agents/claudecode/types'
import type { DaemonServices } from '@/agents/claudecode/types'
import type { SessionExecutor } from '@/agents/shared/run-session'
import { getArtifactStoragePath } from '@/lib/artifact-paths'
import { getCanonicalConfigPath } from '@/lib/config'
import { normalizePath } from '@/lib/utils'

import { ClaudeSessions } from '../claude-sessions/claude-sessions.service'
import { FoldSessionRunner } from '../fold-sessions/fold-session-runner.service'
import {
	decodeReviewHelper,
	invokeReviewHelper,
	makeReviewProgressionDispatch,
	type ReviewProgressionRow,
	type ReviewDispatchClock,
} from './review-progression-dispatch'
import { makeReviewReporting, submitReviewTransport, type ReviewCoordinatorUncertainty } from './review-reporting'

const exec = promisify(execFile)
const digest = (value: unknown) => createHash('sha256').update(canonicalReviewValue(value)).digest('hex')
const absolute = z.string().min(1).refine(isAbsolute)
const pinnedFile = z.strictObject({ path: absolute, digest: ReviewProgressionDigestSchema })
export const ReviewLocalEnrollmentSchema = z.strictObject({
	organizationId: z.uuid(),
	ownerUserId: z.string().min(1),
	hostId: z.string().min(1),
	projectIds: z.array(z.uuid()),
	placements: z.array(z.enum(['project_workspace', 'legacy_directory'])).min(1),
	repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).length(1),
	roots: z.array(absolute).min(1),
	helper: pinnedFile,
	helperConfig: pinnedFile,
	bridge: z.strictObject({
		submitter: pinnedFile,
		configuration: pinnedFile,
		returnRouteRefs: z.array(ReviewProgressionReferenceSchema).min(1),
	}),
	inPlace: z.array(z.strictObject({ directory: absolute, repository: z.string(), branch: z.string().min(1) })),
})
export type ReviewLocalEnrollment = z.infer<typeof ReviewLocalEnrollmentSchema>
export const ReviewStaticHelperConfigSchema = z.strictObject({
	version: z.literal(1),
	options: z
		.strictObject({
			humanlayer_cli: z
				.array(z.string().min(1))
				.min(1)
				.refine((argv) => !argv.some((arg) => /^--(?:token|pat|password|access-token)(?:=|$)/.test(arg))),
			reviewers: z.array(z.string().min(1)).min(1),
			lock_dir: absolute,
			auto_repair: z.boolean(),
			technical_review_receipts: z.boolean(),
			notify_ready: z.boolean(),
			review_source: z.enum(['local', 'github']),
			review_wait_seconds: z.literal(300),
		})
		.refine((options) => options.review_source !== 'github' || options.technical_review_receipts),
})
export const ReviewBridgeBindingSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal('review_bridge_binding'),
	organizationId: z.uuid(),
	ownerUserId: z.string().min(1),
	hostId: z.string().min(1),
	returnRouteRefs: z
		.array(ReviewProgressionReferenceSchema)
		.min(1)
		.refine((refs) => new Set(refs).size === refs.length),
	transport: z
		.strictObject({
			version: z.literal(1),
			inboxDirectory: absolute,
			enrollments: z
				.array(
					z.strictObject({
						enrollmentId: ReviewProgressionReferenceSchema,
						returnRouteRef: ReviewProgressionReferenceSchema,
						repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
						scopeSha256: ReviewProgressionDigestSchema,
						helperPath: absolute,
						helperDigest: ReviewProgressionDigestSchema,
						helperConfigPath: absolute,
						helperConfigDigest: ReviewProgressionDigestSchema,
						slack: z.strictObject({
							appId: z.string().regex(/^A[A-Z0-9]+$/),
							workspaceId: z.string().regex(/^T[A-Z0-9]+$/),
							channelId: z.string().regex(/^[CDG][A-Z0-9]+$/),
							ownerUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
							surface: z.string().regex(/^(channel|thread:\d+\.\d+)$/),
						}),
						requiredReturns: z.array(z.enum(['origin_session', 'artifact', 'native_origin'])).max(3),
					}),
				)
				.max(1000),
		})
		.optional(),
})

async function trustedBytes(path: string, privateFile: boolean, maximum = 1024 * 1024): Promise<Buffer> {
	if ((await realpath(path)) !== path) throw new Error('untrusted_file_path')
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = await file.stat()
		if (
			!stat.isFile() ||
			stat.size > maximum ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & (privateFile ? 0o077 : 0o022)) !== 0
		)
			throw new Error('untrusted_file_permissions')
		return await file.readFile()
	} finally {
		await file.close()
	}
}

async function localEnrollment(id: string): Promise<ReviewLocalEnrollment> {
	const raw = JSON.parse((await trustedBytes(getCanonicalConfigPath(), true)).toString('utf8'))
	const container = z
		.object({ reviewProgressionEnrollments: z.record(z.string(), ReviewLocalEnrollmentSchema) })
		.parse(raw)
	return ReviewLocalEnrollmentSchema.parse(container.reviewProgressionEnrollments[id])
}
async function verifyPinned(file: z.infer<typeof pinnedFile>, privateFile: boolean) {
	const bytes = await trustedBytes(file.path, privateFile)
	if (createHash('sha256').update(bytes).digest('hex') !== file.digest) throw new Error('pinned_file_changed')
	return bytes
}
const canonicalDirectory = (path: string) => realpath(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
const within = (root: string, directory: string) => {
	const path = relative(root, directory)
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
function repositoryOf(remote: string): string | null {
	const match =
		/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
			remote,
		)
	return match?.[1]?.toLowerCase() ?? null
}
async function git(directory: string, ...args: string[]): Promise<string> {
	const result = await exec('git', ['--no-optional-locks', '-C', directory, ...args], {
		timeout: 10_000,
		maxBuffer: 65536,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	})
	return result.stdout.trim()
}

export async function verifyReviewPlacement(snapshot: ReviewProgressionSnapshot, enrollment: ReviewLocalEnrollment) {
	if (
		snapshot.organizationId !== enrollment.organizationId ||
		snapshot.ownerUserId !== enrollment.ownerUserId ||
		snapshot.hostId !== enrollment.hostId ||
		!enrollment.placements.includes(snapshot.placement.kind) ||
		!enrollment.bridge.returnRouteRefs.includes(snapshot.enrollment.returnRouteRef) ||
		!snapshot.setupComplete
	)
		throw new Error('local_enrollment_mismatch')
	if (
		snapshot.placement.kind === 'project_workspace' &&
		!enrollment.projectIds.includes(snapshot.placement.projectId)
	)
		throw new Error('project_not_enrolled')
	await verifyPinned(enrollment.helper, false)
	ReviewStaticHelperConfigSchema.parse(
		JSON.parse((await verifyPinned(enrollment.helperConfig, true)).toString('utf8')),
	)
	await verifyPinned(enrollment.bridge.submitter, false)
	const bridge = ReviewBridgeBindingSchema.parse(
		JSON.parse((await verifyPinned(enrollment.bridge.configuration, true)).toString('utf8')),
	)
	if (
		bridge.organizationId !== snapshot.organizationId ||
		bridge.ownerUserId !== snapshot.ownerUserId ||
		bridge.hostId !== snapshot.hostId ||
		!bridge.returnRouteRefs.includes(snapshot.enrollment.returnRouteRef)
	)
		throw new Error('bridge_binding_mismatch')
	const workingDirectory = await canonicalDirectory(snapshot.workingDirectory)
	const repositoryDirectory = await realpath(await git(workingDirectory, 'rev-parse', '--show-toplevel'))
	const roots = await Promise.all(enrollment.roots.map(canonicalDirectory))
	if (!roots.some((root) => within(root, workingDirectory) && within(root, repositoryDirectory)))
		throw new Error('checkout_outside_enrolled_roots')
	const repository = repositoryOf(await git(repositoryDirectory, 'remote', 'get-url', 'origin'))
	const branch = await git(repositoryDirectory, 'symbolic-ref', '--short', 'HEAD')
	const pushes = (await git(repositoryDirectory, 'remote', 'get-url', '--push', '--all', 'origin')).split('\n')
	const push = pushes[0]
	if (
		!repository ||
		!enrollment.repositories.some((allowed) => allowed.toLowerCase() === repository) ||
		pushes.length !== 1 ||
		!push ||
		repositoryOf(push) !== repository
	)
		throw new Error('repository_not_enrolled')
	await git(repositoryDirectory, 'check-ref-format', `refs/heads/${branch}`)
	if (snapshot.placement.kind === 'project_workspace') {
		const recipe = snapshot.repositories?.[0]
		if (
			snapshot.repositories?.length !== 1 ||
			!recipe?.default ||
			repositoryOf(recipe.remoteUrl) !== repository ||
			recipe.branch !== branch
		)
			throw new Error('workspace_recipe_mismatch')
	} else if (snapshot.workspaceSpec) {
		const spec = snapshot.workspaceSpec
		const repo = spec.repos[0]
		if (
			spec.repos.length !== 1 ||
			!repo?.primary ||
			repo.branch !== branch ||
			(await canonicalDirectory(repo.targetPath)) !== repositoryDirectory
		)
			throw new Error('legacy_recipe_mismatch')
		const source = await canonicalDirectory(resolve(spec.directory, repo.localPath))
		if (
			!roots.some((root) => within(root, source)) ||
			repositoryOf(await git(source, 'remote', 'get-url', 'origin')) !== repository
		)
			throw new Error('legacy_source_mismatch')
	} else {
		const exact = await Promise.all(
			enrollment.inPlace.map(async (entry) => ({
				...entry,
				directory: await canonicalDirectory(entry.directory),
			})),
		)
		if (
			!exact.some(
				(entry) =>
					entry.directory === repositoryDirectory &&
					entry.directory === workingDirectory &&
					entry.repository.toLowerCase() === repository &&
					entry.branch === branch,
			)
		)
			throw new Error('in_place_checkout_not_authorized')
	}
	return ReviewProgressionBindingSchema.parse({
		workingDirectory,
		repositoryDirectory,
		repository,
		branch,
		helperConfigDigest: enrollment.helperConfig.digest,
	})
}

export async function verifyReviewArtifacts(
	snapshot: ReviewProgressionSnapshot,
	root = getArtifactStoragePath(snapshot.taskId),
): Promise<void> {
	const directory = await realpath(root)
	for (const expected of snapshot.scopeInputs.artifacts) {
		const bytes = await trustedBytes(join(directory, expected.fileName), false, 50 * 1024 * 1024)
		if (
			bytes.length !== expected.fileSizeBytes ||
			createHash('sha256').update(bytes).digest('hex') !== expected.bytesSha256
		)
			throw new Error('accepted_artifact_bytes_changed')
	}
	const context = await trustedBytes(join(directory, reviewDeliveryContextFile(snapshot.sourceSessionId)), false)
	if (context.toString('utf8') !== canonicalReviewValue(reviewDeliveryContext(snapshot)))
		throw new Error('delivery_context_changed')
}

export async function prepareReviewSessionArtifacts(
	services: Pick<DaemonServices, 'syncService'>,
	snapshot: ReviewProgressionSnapshot,
): Promise<void> {
	const context = await services.syncService.ensureTaskSync(snapshot.taskId, normalizePath(snapshot.workingDirectory))
	if (!context.flushArtifactWrites) throw new Error('artifact_sync_unavailable')
	await context.flushArtifactWrites([
		...snapshot.scopeInputs.artifacts,
		{
			fileName: reviewDeliveryContextFile(snapshot.sourceSessionId),
			contentHash: artifactHash(canonicalReviewValue(reviewDeliveryContext(snapshot))),
		},
	])
}

/** Admission is authoritative even when no progression collection has synchronized. Never runs a helper. */
export async function admitReviewSession(
	sessionId: string,
	api: ORPCClient,
	load = localEnrollment,
	verify = verifyReviewPlacement,
	prepare: (snapshot: ReviewProgressionSnapshot) => Promise<unknown> = async () => {},
	verifyArtifacts = verifyReviewArtifacts,
	execution?: ReviewExecutionSession,
	observations?: ReviewWriterObservations,
	liveFollowUp = false,
): Promise<boolean> {
	const first = ReviewProgressionAdmissionSchema.parse(await api.reviewProgression.admission({ sessionId }))
	if (first.kind === 'not_enrolled') return true
	if (first.kind === 'blocked') return false
	const snapshot = first.snapshot
	if (
		(snapshot.executionSessionId ?? snapshot.sourceSessionId) !== sessionId ||
		!execution ||
		snapshot.executionDigest !== digest(reviewExecutionPayload(execution)) ||
		!localReviewLaunchAllowed(execution, observations, liveFollowUp, snapshot.sourceSessionId)
	)
		return false
	const enrollment = await load(snapshot.enrollment.enrollmentId)
	const binding = await verify(snapshot, enrollment)
	const bindingDigest = digest(binding)
	if (snapshot.verifiedBinding === null) {
		const confirmed = await api.reviewProgression.confirmPlacement({
			taskId: snapshot.taskId,
			sourceSessionId: snapshot.sourceSessionId,
			acceptedLaunchDigest: snapshot.acceptedLaunchDigest,
			bindingDigest,
			binding,
		})
		if (canonicalReviewValue(confirmed) !== canonicalReviewValue(binding)) return false
	} else if (
		snapshot.bindingDigest !== bindingDigest ||
		canonicalReviewValue(snapshot.verifiedBinding) !== canonicalReviewValue(binding)
	)
		return false
	const again = ReviewProgressionAdmissionSchema.parse(await api.reviewProgression.admission({ sessionId }))
	const expected = {
		...snapshot,
		verifiedBinding: binding,
		bindingDigest,
		scopeSha256: digest(reviewHelperScope(snapshot.scopeInputs, binding)),
	}
	if (again.kind !== 'enrolled' || canonicalReviewValue(again.snapshot) !== canonicalReviewValue(expected))
		return false
	if (
		canonicalReviewValue(await verify(again.snapshot, await load(snapshot.enrollment.enrollmentId))) !==
		canonicalReviewValue(binding)
	)
		return false
	await prepare(again.snapshot)
	await verifyArtifacts(again.snapshot)
	const final = ReviewProgressionAdmissionSchema.parse(await api.reviewProgression.admission({ sessionId }))
	const allowed =
		final.kind === 'enrolled' &&
		canonicalReviewValue(final.snapshot) === canonicalReviewValue(expected) &&
		final.snapshot.executionDigest === digest(reviewExecutionPayload(execution)) &&
		localReviewLaunchAllowed(execution, observations, liveFollowUp, snapshot.sourceSessionId) &&
		canonicalReviewValue(await verify(final.snapshot, await load(snapshot.enrollment.enrollmentId))) ===
			canonicalReviewValue(binding)
	if (allowed && observations && !liveFollowUp) {
		observations.admitted ??= new Map()
		observations.admitted.set(sessionId, {
			taskId: snapshot.taskId,
			sourceSessionId: snapshot.sourceSessionId,
			digest: digest(reviewExecutionPayload(execution)),
		})
	}
	return allowed
}

const blockedSessions = new Set<string>()
export async function checkReviewSessionLaunch(
	sessionId: string,
	api: ORPCClient,
	prepare?: (snapshot: ReviewProgressionSnapshot) => Promise<unknown>,
	execution?: ReviewExecutionSession,
	observations?: ReviewWriterObservations,
	liveFollowUp = false,
): Promise<boolean> {
	try {
		if (
			await admitReviewSession(
				sessionId,
				api,
				localEnrollment,
				verifyReviewPlacement,
				prepare,
				verifyReviewArtifacts,
				execution,
				observations,
				liveFollowUp,
			)
		) {
			if (blockedSessions.has(sessionId)) await api.sessions.update({ sessionId, errorMessage: '' })
			blockedSessions.delete(sessionId)
			return true
		}
	} catch {
		// Unknown admission is not stock launch permission, including on older servers.
	}
	if (!blockedSessions.has(sessionId)) {
		blockedSessions.add(sessionId)
		try {
			await api.sessions.update({
				sessionId,
				errorMessage:
					'Could not verify delivery setup. No session has started. Ask the host owner to check the selected enrollment and return route.',
			})
		} catch {
			blockedSessions.delete(sessionId)
		}
	}
	return false
}

const writerIdentity = (session: ReviewExecutionSession) =>
	digest(
		Object.fromEntries(
			Object.entries(reviewExecutionPayload(session)).filter(
				([key]) => !['status', 'coding_agent_session_id'].includes(key),
			),
		),
	)
export type ReviewWriterObservations = {
	readonly runs: Map<string, { taskId: string; identity: string; running: boolean; uncertain: boolean }>
	admitted?: Map<string, { taskId: string; sourceSessionId: string; digest: string }>
	finished?: (taskId: string) => void
}
function localReviewLaunchAllowed(
	session: ReviewExecutionSession,
	observations: ReviewWriterObservations | undefined,
	liveFollowUp = false,
	sourceSessionId = session.id,
) {
	if (!session.task_id || !observations) return false
	if (observations.runs.has(session.id) && observations.runs.get(session.id)?.taskId !== session.task_id) return false
	if (sourceSessionId !== session.id && observations.runs.get(sourceSessionId)?.taskId !== session.task_id)
		return false
	if (observations.runs.size >= 256 && !observations.runs.has(session.id)) return false
	if ((observations.admitted?.size ?? 0) >= 256 && !observations.admitted?.has(session.id)) return false
	for (const [id, run] of observations.runs) {
		if (run.taskId !== session.task_id) continue
		// This permits only the existing Claude mailbox owner, never executor reconstruction.
		if (liveFollowUp && session.coding_agent === 'claude' && id === session.id && run.running) continue
		if (run.running || run.uncertain) return false
	}
	return session.status !== 'resuming' || observations.runs.has(session.id)
}
export function observeReviewExecutor(
	execute: SessionExecutor,
	observations: ReviewWriterObservations,
	supervised = false,
): SessionExecutor {
	return async (context, resume, fork) => {
		const { session } = context
		const permit = observations.admitted?.get(session.id)
		const admission = permit
			? null
			: ReviewProgressionAdmissionSchema.parse(
					await context.services.orpc.reviewProgression.admission({ sessionId: session.id }),
				)
		if (
			(!permit && admission?.kind !== 'not_enrolled') ||
			(permit &&
				(permit.taskId !== session.task_id ||
					permit.digest !== digest(reviewExecutionPayload(session)) ||
					!localReviewLaunchAllowed(session, observations, false, permit.sourceSessionId)))
		)
			throw new Error(
				'Could not start this session. Earlier work could not be verified as stopped. Ask the host owner to reconcile it before retrying.',
			)
		observations.admitted?.delete(session.id)
		if (!session.task_id || (observations.runs.size >= 256 && !observations.runs.has(session.id)))
			return execute(context, resume, fork)
		const previous = observations.runs.get(session.id)
		const record = {
			taskId: session.task_id,
			identity: writerIdentity(session),
			running: true,
			// Executor settlement alone is not complete child-cleanup evidence.
			uncertain: session.coding_agent !== 'claude' || previous?.running === true || previous?.uncertain === true,
		}
		observations.runs.set(session.id, record)
		let handedOff = false
		try {
			await execute(context, resume, fork)
			handedOff = supervised
		} catch (error) {
			record.uncertain = true
			throw error
		} finally {
			if (!handedOff) {
				record.running = false
				observations.finished?.(record.taskId)
			}
		}
	}
}

/** Called only from the existing daemon subscription owner. No installation or enrollment is performed. */
export function makeManagedReviewProgression(
	services: DaemonServices,
	dependencies: Partial<{
		load: typeof localEnrollment
		verify: typeof verifyReviewPlacement
		prepare: typeof prepareReviewSessionArtifacts
		verifyArtifacts: typeof verifyReviewArtifacts
		actualWriters: () => Promise<Set<string>>
		invoke: typeof invokeReviewHelper
		submitReport: typeof submitReviewTransport
		retainReport: ReturnType<typeof makeReviewReporting>['retain']
		clock: ReviewDispatchClock
	}> = {},
) {
	const observations = services.reviewWriterObservations
	const claims = new Map<string, string>()
	const pendingAcks = new Map<string, Parameters<ORPCClient['reviewProgression']['ack']>[0]>()
	const pendingReportSnapshots = new Map<string, ReviewProgressionSnapshot>()
	const pendingDeliveries = new Map<string, Parameters<ORPCClient['reviewProgression']['recordDelivery']>[0]>()
	const progressKeys = new Map<string, Set<string>>()
	const uncertainHelpers = new Map<string, { claimId: string; pid: number | null; exited: boolean }>()
	const warned = new Set<string>()
	const coordinatorUncertainty = new Map<string, ReviewCoordinatorUncertainty>()
	const attention = (taskId: string) => {
		if (warned.has(taskId)) return
		warned.add(taskId)
		const source = services.collections.reviewProgression?.toArray.find(
			(row) => row.task_id === taskId,
		)?.source_session_id
		if (source)
			void services.orpc.sessions
				.update({
					sessionId: source,
					errorMessage:
						'Review progression needs reconciliation. Retained writer, helper, lock or publication state could not be verified; no replacement has started.',
				})
				.catch(() => warned.delete(taskId))
	}
	const actualWriters =
		dependencies.actualWriters ??
		(() =>
			services.daemonRuntime.runPromise(
				Effect.gen(function* () {
					const claude = yield* ClaudeSessions
					const fold = yield* FoldSessionRunner
					return new Set([...(yield* claude.activeSessionIds), ...(yield* fold.activeSessionIds)])
				}),
			))
	const writersStopped = async (row: ReviewProgressionRow) => {
		const sessions = services.collections.sessions.toArray.filter((session) => session.task_id === row.task_id)
		const source = sessions.find((session) => session.id === row.source_session_id)
		if (!source || source.status !== 'ready_for_input') return false
		const active = await actualWriters()
		if (sessions.some((session) => active.has(session.id) || observations?.runs.get(session.id)?.running))
			return false
		if (sessions.some((session) => observations?.runs.get(session.id)?.uncertain))
			throw new Error('review_writer_identity_unknown')
		if (sessions.some((session) => !['draft', 'ready_for_input', 'interrupted', 'failed'].includes(session.status)))
			return false
		const prove = (id: string) => {
			const session = sessions.find((item) => item.id === id),
				run = observations?.runs.get(id)
			if (!session || !run || run.running || run.uncertain || run.identity !== writerIdentity(session))
				throw new Error('review_writer_identity_unknown')
		}
		// A committed delivery plus an acknowledgement represents an already reconciled historical source.
		// A new work-entry marker stops that stage and requires fresh actual executor evidence again.
		if (!row.verified_pr_binding || !row.last_ack) prove(row.source_session_id)
		else if (row.stage === 'stopped' && row.admitted_execution) prove(row.admitted_execution.sessionId)
		if (row.action_id) prove(row.action_id)
		return true
	}
	const runAttempt = async (row: ReviewProgressionRow, signal: AbortSignal) => {
		if (services.automationTargetSessionId !== undefined || !observations || row.planning_suspended) return
		const pending = pendingAcks.get(row.task_id)
		if (pending) {
			const reportSnapshot = pendingReportSnapshots.get(row.task_id)
			if (reportSnapshot) {
				await (dependencies.retainReport ?? reporting.retain)(
					reportSnapshot,
					pending.validatedOutcome,
					signal,
					pending.claimedRevision,
				)
				pendingReportSnapshots.delete(row.task_id)
			}
			const delivery = pendingDeliveries.get(row.task_id)
			if (delivery) {
				await services.orpc.reviewProgression.recordDelivery(delivery, { signal })
				pendingDeliveries.delete(row.task_id)
			}
			await services.orpc.reviewProgression.ack(pending, { signal })
			pendingAcks.delete(row.task_id)
			claims.delete(row.task_id)
			return
		}
		if (uncertainHelpers.has(row.task_id) || (row.claim_id && claims.get(row.task_id) !== row.claim_id))
			throw new Error('review_prior_helper_unknown')
		if (await writersStopped(row)) coordinatorUncertainty.delete(row.task_id)
		const claimId = claims.get(row.task_id) ?? randomUUID()
		claims.set(row.task_id, claimId)
		const request = { taskId: row.task_id, claimId, expectedWakeRevision: row.wake_revision.toString() }
		// A lost response is replayed with the SAME identity, never a replacement generation.
		let claim
		try {
			claim = ReviewClaimResultSchema.parse(await services.orpc.reviewProgression.claim(request, { signal }))
		} catch {
			claim = ReviewClaimResultSchema.parse(await services.orpc.reviewProgression.claim(request, { signal }))
		}
		if (claim.kind !== 'claimed') {
			claims.delete(row.task_id)
			if (claim.kind === 'blocked') attention(row.task_id)
			return
		}
		const claimed = claim
		const fence = {
			taskId: row.task_id,
			claimId,
			generation: claimed.generation,
			claimedRevision: claimed.claimedRevision,
		}
		const controller = new AbortController()
		const abort = () => controller.abort()
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) abort()
		let timer: ReturnType<typeof setTimeout> | undefined
		let renewing: Promise<void> | undefined
		let finished = false
		const renew = () => {
			if (finished || controller.signal.aborted) return
			timer = setTimeout(() => {
				renewing = services.orpc.reviewProgression
					.renew(
						{ taskId: row.task_id, claimId, generation: claimed.generation },
						{ signal: controller.signal },
					)
					.then(() => renew())
					.catch(() => controller.abort())
			}, 20_000)
		}
		renew()
		try {
			const snapshot = claimed.snapshot
			const scopeSha256 = snapshot.scopeSha256
			if (
				snapshot.taskId !== row.task_id ||
				snapshot.sourceSessionId !== row.source_session_id ||
				snapshot.organizationId !== row.organization_id ||
				snapshot.ownerUserId !== row.resource_owner_user_id ||
				snapshot.hostId !== row.host_id ||
				snapshot.acceptedLaunchDigest !== row.accepted_launch_digest
			)
				throw new Error('review_claim_binding_changed')
			if (!snapshot.verifiedBinding || !scopeSha256) throw new Error('review_writer_state_changed')
			const invoke = async (operation: 'step' | 'observe-delivery', apply: boolean) => {
				if (controller.signal.aborted) throw new Error('review_claim_lost')
				const fresh = ReviewClaimResultSchema.parse(
					await services.orpc.reviewProgression.claim(request, { signal: controller.signal }),
				)
				if (
					fresh.kind !== 'claimed' ||
					fresh.generation !== claimed.generation ||
					canonicalReviewValue(fresh.snapshot) !== canonicalReviewValue(snapshot)
				)
					throw new Error('review_snapshot_changed')
				const enrollment = await (dependencies.load ?? localEnrollment)(snapshot.enrollment.enrollmentId)
				const binding = await (dependencies.verify ?? verifyReviewPlacement)(snapshot, enrollment)
				if (
					digest(binding) !== snapshot.bindingDigest ||
					canonicalReviewValue(binding) !== canonicalReviewValue(snapshot.verifiedBinding)
				)
					throw new Error('review_binding_changed')
				await (dependencies.prepare ?? prepareReviewSessionArtifacts)(services, snapshot)
				await (dependencies.verifyArtifacts ?? verifyReviewArtifacts)(snapshot)
				if ((apply && !(await writersStopped(row))) || controller.signal.aborted)
					throw new Error('review_writer_state_changed')
				const process = { claimId, pid: null as number | null, exited: false }
				uncertainHelpers.set(row.task_id, process)
				const result = await services.daemonRuntime.runPromise(
					(dependencies.invoke ?? invokeReviewHelper)({
						snapshot,
						enrollment,
						pr: claimed.prBinding?.pr ?? null,
						operation,
						apply,
						started: (pid) => {
							process.pid = pid
						},
						exited: () => {
							process.exited = true
						},
					}),
					{ signal: controller.signal },
				)
				if (!process.exited) throw new Error('review_helper_exit_unknown')
				const output = decodeReviewHelper(result.stdout, result.exitCode, {
					repository: binding.repository,
					taskId: snapshot.taskId,
					scopeSha256,
					pr: operation === 'step' ? claimed.prBinding?.pr : undefined,
				})
				if (!output.context) throw new Error('review_lock_or_journal_unknown')
				uncertainHelpers.delete(row.task_id)
				return output
			}
			let output = await invoke(claimed.prBinding ? 'step' : 'observe-delivery', false)
			if (
				!(await writersStopped(row)) &&
				!['waiting_writer', 'waiting_review', 'needs_decision'].includes(output.result.status)
			)
				throw new Error('review_writer_state_changed')
			const priorOutcome = row.last_outcome
			const retainedCompletion =
				row.action_id &&
				row.last_outcome?.continuation.kind === 'reconcile' &&
				['reviewed', 'repaired'].includes(row.last_outcome.status) &&
				!['waiting_writer', 'needs_decision'].includes(output.result.status)
			// The read-only helper owns the actual PR journal and acquires the existing flock.
			// An unexpected action is retained by ack, never treated as permission to launch another.
			if (
				claimed.prBinding &&
				!retainedCompletion &&
				output.result.status !== 'waiting_writer' &&
				output.result.status !== 'waiting_review' &&
				output.result.status !== 'needs_decision'
			)
				output = await invoke('step', true)
			const outcomeInput = {
				status: output.result.status,
				reason: output.result.reason,
				context: output.context,
				continuation: output.continuation,
				verified: output.result.verified,
			}
			// A newer wake can preserve the old action after its completed result. Settle that
			// identity with a fresh acknowledgement before allowing the helper to request another writer.
			if (retainedCompletion && priorOutcome) {
				outcomeInput.status = priorOutcome.status
				outcomeInput.reason = 'retained_action_reconciled'
				outcomeInput.verified = undefined
				outcomeInput.continuation = {
					kind: 'reconcile',
					progressKey: digest({ actionId: row.action_id, context: output.context }),
				}
			}
			let outcome = ReviewOutcomeSchema.parse(outcomeInput)
			if (outcome.continuation.kind === 'reconcile') {
				const seen = progressKeys.get(row.task_id) ?? new Set<string>()
				const key = outcome.continuation.progressKey
				if (
					seen.has(key) ||
					seen.size >= 32 ||
					(row.continuation.kind === 'reconcile' && row.continuation.progressKey === key)
				)
					outcome = {
						status: 'needs_decision',
						reason: 'review_progress_did_not_advance',
						context: outcome.context,
						continuation: { kind: 'stop' },
					}
				else {
					seen.add(key)
					progressKeys.set(row.task_id, seen)
				}
			}
			const acknowledgement = { ...fence, resultDigest: digest(outcome), validatedOutcome: outcome }
			if (controller.signal.aborted) throw new Error('review_claim_lost')
			pendingAcks.set(row.task_id, acknowledgement)
			pendingReportSnapshots.set(row.task_id, snapshot)
			await (dependencies.retainReport ?? reporting.retain)(
				snapshot,
				outcome,
				controller.signal,
				claimed.claimedRevision,
			)
			pendingReportSnapshots.delete(row.task_id)
			if (outcome.status === 'delivery_observed') {
				const context = outcome.context
				if (!context?.pr || !context.headSha || !snapshot.verifiedBinding)
					throw new Error('review_delivery_binding_missing')
				const delivery = {
					...acknowledgement,
					binding: {
						repository: context.repository,
						pr: context.pr,
						branch: snapshot.verifiedBinding.branch,
						headSha: context.headSha,
						scopeSha256: context.scopeSha256,
						sourceSessionId: snapshot.sourceSessionId,
					},
				}
				pendingDeliveries.set(row.task_id, delivery)
				pendingAcks.set(row.task_id, acknowledgement)
				try {
					await services.orpc.reviewProgression.recordDelivery(delivery, { signal: controller.signal })
				} catch {
					await services.orpc.reviewProgression.recordDelivery(delivery, { signal: controller.signal })
				}
				pendingDeliveries.delete(row.task_id)
			}
			if (controller.signal.aborted) throw new Error('review_claim_lost')
			pendingAcks.set(row.task_id, acknowledgement)
			try {
				await services.orpc.reviewProgression.ack(acknowledgement, { signal: controller.signal })
			} catch {
				await services.orpc.reviewProgression.ack(acknowledgement, { signal: controller.signal })
			}
			pendingAcks.delete(row.task_id)
			claims.delete(row.task_id)
			if (outcome.status === 'needs_decision') attention(row.task_id)
			else warned.delete(row.task_id)
		} finally {
			finished = true
			if (timer) clearTimeout(timer)
			signal.removeEventListener('abort', abort)
			controller.abort()
			await renewing
		}
	}
	const run = async (row: ReviewProgressionRow, signal: AbortSignal) => {
		try {
			await runAttempt(row, signal)
		} catch (error) {
			const reason = error instanceof Error ? error.message : ''
			const typed =
				reason === 'review_writer_identity_unknown' || reason === 'review_prior_helper_unknown'
					? reason
					: uncertainHelpers.has(row.task_id)
						? 'review_helper_state_unknown'
						: null
			if (
				typed &&
				!signal.aborted &&
				(coordinatorUncertainty.size < 256 || coordinatorUncertainty.has(row.task_id))
			) {
				coordinatorUncertainty.set(row.task_id, typed)
				reporting.update(row)
			}
			throw error
		}
	}
	const dispatcher = makeReviewProgressionDispatch({ run, attention, clock: dependencies.clock })
	const reporting = makeReviewReporting(
		services.orpc,
		async (snapshot) => {
			const enrollment = await (dependencies.load ?? localEnrollment)(snapshot.enrollment.enrollmentId)
			const bridge = ReviewBridgeBindingSchema.parse(
				JSON.parse((await verifyPinned(enrollment.bridge.configuration, true)).toString('utf8')),
			)
			if (!bridge.transport) return null
			if (
				bridge.organizationId !== snapshot.organizationId ||
				bridge.ownerUserId !== snapshot.ownerUserId ||
				bridge.hostId !== snapshot.hostId ||
				enrollment.organizationId !== snapshot.organizationId ||
				enrollment.ownerUserId !== snapshot.ownerUserId ||
				enrollment.hostId !== snapshot.hostId
			)
				throw new Error('review_report_owner')
			const matches = bridge.transport.enrollments.filter(
				(item) => item.enrollmentId === snapshot.enrollment.enrollmentId,
			)
			const route = matches[0]
			if (
				matches.length !== 1 ||
				!route ||
				route.returnRouteRef !== snapshot.enrollment.returnRouteRef ||
				!enrollment.bridge.returnRouteRefs.includes(route.returnRouteRef) ||
				route.repository !== snapshot.verifiedBinding?.repository ||
				route.scopeSha256 !== snapshot.scopeSha256 ||
				!route.requiredReturns.includes('origin_session') ||
				!route.requiredReturns.includes('artifact') ||
				route.requiredReturns.includes('native_origin') ||
				new Set(route.requiredReturns).size !== route.requiredReturns.length
			)
				throw new Error('review_report_route')
			await verifyPinned(enrollment.bridge.submitter, false)
			return {
				directory: bridge.transport.inboxDirectory,
				requiredReturns: ['origin_session', 'artifact'],
				submit: async (value, signal) => {
					await verifyPinned(enrollment.bridge.configuration, true)
					await verifyPinned(enrollment.bridge.submitter, false)
					return (dependencies.submitReport ?? submitReviewTransport)(
						enrollment.bridge.submitter.path,
						{
							BRIDGE_REVIEW_BINDING_FILE: enrollment.bridge.configuration.path,
							BRIDGE_REVIEW_BINDING_SHA256: enrollment.bridge.configuration.digest,
						},
						value,
						signal,
					)
				},
			}
		},
		attention,
		async (taskId) => {
			if (services.automationTargetSessionId !== undefined) return false
			const row = services.collections.reviewProgression?.toArray.find((item) => item.task_id === taskId)
			if (!row) return false
			try {
				const enrollment = await (dependencies.load ?? localEnrollment)(row.enrollment_id)
				return !!ReviewBridgeBindingSchema.parse(
					JSON.parse((await verifyPinned(enrollment.bridge.configuration, true)).toString('utf8')),
				).transport
			} catch {
				return false
			}
		},
		(taskId) => coordinatorUncertainty.get(taskId) ?? null,
	)
	if (observations) observations.finished = dispatcher.writerFinished
	return {
		update: (row: ReviewProgressionRow) => {
			dispatcher.update(row)
			reporting.update(row)
		},
		remove: (taskId: string) => {
			coordinatorUncertainty.delete(taskId)
			dispatcher.remove(taskId)
			reporting.remove(taskId)
		},
		async stop() {
			if (observations?.finished === dispatcher.writerFinished) observations.finished = undefined
			await dispatcher.stop()
			await reporting.stop()
		},
	}
}

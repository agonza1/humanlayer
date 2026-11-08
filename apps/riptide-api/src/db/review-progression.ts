import { createHash } from 'node:crypto'

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { reviewProgression } from '@humanlayer/db/tables/review-progression'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import {
	ReviewAcceptedArtifactSchema,
	ReviewScopeInputsSchema,
	REVIEW_TASK_SCOPE_FIELDS,
	type ReviewAcceptedArtifact,
} from '@humanlayer/db/zodschemas/review-progression'
import type {
	ReviewProgressionEnrollment,
	ReviewProgressionPlacement,
} from '@humanlayer/db/zodschemas/review-progression'
import {
	canonicalReviewValue,
	ReviewProgressionEnrollmentSchema,
	ReviewProgressionPlacementSchema,
	reviewExecutionPayload,
	validateWorkEntry,
	workEntryValues,
	workflowMutationPayload,
	workflowPatch,
	type WorkEntry,
	type WorkflowPatch,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { ORPCError } from '@orpc/server'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { hash } from 'ohash'

import type { PreparedTicketArtifactBundle } from '../lib/linear-ticket-artifacts'
import type { IS3Service } from '../lib/s3-service'

type Executor = PgDatabase<PostgresJsQueryResultHKT>
export const reviewDigest = (value: unknown) => createHash('sha256').update(canonicalReviewValue(value)).digest('hex')

/** The caller's semantic mutation and its hint commit together; lease housekeeping never calls this. */
export async function wakeReviewTask(tx: Executor, organizationId: string, taskId: string, hostId?: string) {
	await tx
		.update(reviewProgression)
		.set({ wake_revision: sql`${reviewProgression.wake_revision} + 1` })
		.where(
			and(
				eq(reviewProgression.organization_id, organizationId),
				eq(reviewProgression.task_id, taskId),
				hostId === undefined ? undefined : eq(reviewProgression.host_id, hostId),
			),
		)
}

export async function wakeReviewWorkspace(
	tx: Executor,
	identity: { organizationId: string; workspaceId: string; userId: string; hostId: string },
) {
	await tx
		.update(reviewProgression)
		.set({ wake_revision: sql`${reviewProgression.wake_revision} + 1` })
		.where(
			and(
				eq(reviewProgression.organization_id, identity.organizationId),
				eq(reviewProgression.resource_owner_user_id, identity.userId),
				eq(reviewProgression.host_id, identity.hostId),
				sql`${reviewProgression.placement}->>'workspaceId' = ${identity.workspaceId}`,
			),
		)
}

export async function retainReviewEnrollment(
	tx: Executor,
	input: {
		taskId: string
		organizationId: string
		ownerUserId: string
		hostId: string
		sourceSessionId: string
		enrollment: ReviewProgressionEnrollment
		placement: ReviewProgressionPlacement
		acceptedLaunch: Record<string, unknown>
	},
) {
	const enrollment = ReviewProgressionEnrollmentSchema.parse(input.enrollment)
	const placement = ReviewProgressionPlacementSchema.parse(input.placement)
	const [task] = await tx
		.select()
		.from(tasks)
		.where(and(eq(tasks.id, input.taskId), eq(tasks.organization_id, input.organizationId)))
		.limit(1)
	if (!task) throw new Error('accepted_task_missing')
	const workspace =
		placement.kind === 'project_workspace'
			? (await tx.select().from(workspaces).where(eq(workspaces.id, placement.workspaceId)).limit(1))[0]
			: null
	const scopeInputs = ReviewScopeInputsSchema.parse({
		task: Object.fromEntries(REVIEW_TASK_SCOPE_FIELDS.map((key) => [key, task[key]])),
		accepted: input.acceptedLaunch.acceptedTaskArtifact,
		artifacts: input.acceptedLaunch.acceptedArtifacts,
		placement,
		repositories: workspace?.repositories ?? null,
		workspaceSpec: task.workspace_spec,
	})
	await tx.insert(reviewProgression).values({
		task_id: input.taskId,
		organization_id: input.organizationId,
		resource_owner_user_id: input.ownerUserId,
		host_id: input.hostId,
		source_session_id: input.sourceSessionId,
		enrollment_id: enrollment.enrollmentId,
		return_route_ref: enrollment.returnRouteRef,
		placement,
		accepted_launch: input.acceptedLaunch,
		accepted_launch_digest: reviewDigest(input.acceptedLaunch),
		scope_inputs: scopeInputs,
	})
	await tx.update(tasks).set({ workflow_revision: 1n }).where(eq(tasks.id, input.taskId))
	await tx
		.update(sessions)
		.set({ execution_phase: 'implementation', execution_phase_at: BigInt(Date.now()) })
		.where(eq(sessions.id, input.sourceSessionId))
}

export async function verifyReviewLaunchReplay(
	tx: Executor,
	taskId: string,
	enrollment: ReviewProgressionEnrollment | undefined,
	acceptedLaunch: Record<string, unknown>,
) {
	const [row] = await tx.select().from(reviewProgression).where(eq(reviewProgression.task_id, taskId)).limit(1)
	if (!row && !enrollment) return
	if (
		!row ||
		!enrollment ||
		row.enrollment_id !== enrollment.enrollmentId ||
		row.return_route_ref !== enrollment.returnRouteRef ||
		row.accepted_launch_digest !== reviewDigest(acceptedLaunch)
	) {
		throw new Error(
			'Could not replay this launch. Its enrollment or accepted inputs changed. Reconcile the existing task before retrying.',
		)
	}
}

type AcceptedReviewLaunchInput = {
	taskContent: string
	importedTicket?: PreparedTicketArtifactBundle
	preparedReviewArtifacts?: ReviewAcceptedArtifact[]
	reviewProgressionEnrollment?: ReviewProgressionEnrollment
	attachments?: readonly { fileName: string }[]
	actor?: unknown
	intent?: unknown
	organizationId?: string
	userId?: string
}

export function acceptedReviewLaunch<T extends AcceptedReviewLaunchInput>(input: T) {
	const {
		actor: _actor,
		importedTicket: ticket,
		preparedReviewArtifacts,
		intent: _intent,
		organizationId: _org,
		userId: _user,
		...launch
	} = input
	const content = input.taskContent
	const acceptedTaskArtifact = ticket
		? [content.trim(), `See [${ticket.label}](./${ticket.fileName}).`].filter(Boolean).join('\n\n')
		: content.trim()
			? content
			: ''
	const acceptedArtifacts = preparedReviewArtifacts ?? textReviewArtifacts(acceptedTaskArtifact, ticket)
	if (
		launch.reviewProgressionEnrollment &&
		!preparedReviewArtifacts &&
		((Array.isArray(launch.attachments) && launch.attachments.length) || ticket?.images.length)
	)
		throw new Error('accepted_binary_bytes_not_verified')
	return { ...launch, acceptedTaskArtifact, acceptedArtifacts }
}

const bytesDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function textReviewArtifacts(content: string, ticket?: PreparedTicketArtifactBundle): ReviewAcceptedArtifact[] {
	const artifacts = [{ fileName: 'task.md', content }]
	if (ticket) artifacts.push({ fileName: ticket.fileName, content: ticket.content })
	return artifacts
		.map(({ fileName, content }) =>
			ReviewAcceptedArtifactSchema.parse({
				fileName,
				storageType: 'postgres',
				contentHash: hash(content),
				contentType: 'text/markdown',
				fileSizeBytes: Buffer.byteLength(content),
				bytesSha256: bytesDigest(content),
			}),
		)
		.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
}

/** Pin provider bytes at intake, not a mutable URL or a provider-specific metadata hash. */
type ReviewArtifactDownload = (url: string, options: RequestInit) => Promise<Response>
export async function prepareReviewArtifacts(
	input: {
		taskId: string
		organizationId: string
		taskContent: string
		importedTicket?: PreparedTicketArtifactBundle
		attachments: readonly { fileName: string; contentHash: string; contentType: string; fileSizeBytes: number }[]
	},
	s3: Pick<IS3Service, 'getPresignedDownloadUrl'>,
	download: ReviewArtifactDownload = fetch,
): Promise<ReviewAcceptedArtifact[]> {
	const ticket = input.importedTicket
	const content = ticket
		? [input.taskContent.trim(), `See [${ticket.label}](./${ticket.fileName}).`].filter(Boolean).join('\n\n')
		: input.taskContent.trim()
			? input.taskContent
			: ''
	const result = textReviewArtifacts(content, ticket)
	for (const item of [
		...input.attachments.map((entry) => ({
			...entry,
			s3Key: `${input.organizationId}/${input.taskId}/${entry.fileName}`,
			imported: false,
		})),
		...(ticket?.images ?? []).map((entry) => ({ ...entry, imported: true })),
	]) {
		ReviewAcceptedArtifactSchema.parse({
			fileName: item.fileName,
			contentHash: item.contentHash,
			contentType: item.contentType,
			fileSizeBytes: item.fileSizeBytes,
			storageType: 's3',
			bytesSha256: '0'.repeat(64),
		})
		if (!item.s3Key.startsWith(`${input.organizationId}/${input.taskId}/`))
			throw new Error('accepted_binary_location_mismatch')
		const response = await download(await s3.getPresignedDownloadUrl(item.s3Key), {
			signal: AbortSignal.timeout(30_000),
			redirect: 'error',
		})
		if (!response.ok || !response.body) throw new Error('accepted_binary_unavailable')
		const reader = response.body.getReader(),
			chunks: Uint8Array[] = []
		let size = 0
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				size += value.byteLength
				if (size > item.fileSizeBytes) throw new Error('accepted_binary_size_changed')
				chunks.push(value)
			}
		} finally {
			await reader.cancel()
		}
		const bytes = Buffer.concat(chunks),
			sha = bytesDigest(bytes)
		const hashes = item.imported ? [sha, hash(new Uint8Array(bytes)), hash(bytes.toString('base64'))] : [sha]
		if (size !== item.fileSizeBytes || !hashes.includes(item.contentHash))
			throw new Error('accepted_binary_content_changed')
		result.push(
			ReviewAcceptedArtifactSchema.parse({
				fileName: item.fileName,
				storageType: 's3',
				contentHash: item.contentHash,
				contentType: item.contentType,
				fileSizeBytes: size,
				bytesSha256: sha,
			}),
		)
	}
	if (new Set(result.map((item) => item.fileName)).size !== result.length || result.length > 100)
		throw new Error('ambiguous_accepted_artifacts')
	return result.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
}

export const reviewRowForTask = (tx: Executor, organizationId: string, taskId: string) =>
	tx
		.select()
		.from(reviewProgression)
		.where(and(eq(reviewProgression.organization_id, organizationId), eq(reviewProgression.task_id, taskId)))
		.limit(1)

function rejectReview(message: string): never {
	throw new ORPCError('CONFLICT', { message })
}

function receiptValue(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString()
	if (Array.isArray(value)) return value.map(receiptValue)
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter((entry) => entry[1] !== undefined)
				.map(([key, item]) => [key, receiptValue(item)]),
		)
	return value
}
function receiptResult(result: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(result)
			.filter((entry) => entry[1] !== undefined)
			.map(([key, value]) => [key, receiptValue(value)]),
	)
}

/** Every enrolled writer locks task -> progression -> sessions by id -> inputs by id. */
export async function lockReviewTask(tx: Executor, organizationId: string, taskId: string) {
	const [task] = await tx
		.select()
		.from(tasks)
		.where(and(eq(tasks.organization_id, organizationId), eq(tasks.id, taskId)))
		.for('update')
	const [row] = await tx
		.select()
		.from(reviewProgression)
		.where(and(eq(reviewProgression.organization_id, organizationId), eq(reviewProgression.task_id, taskId)))
		.for('update')
	const siblings = row
		? await tx
				.select()
				.from(sessions)
				.where(and(eq(sessions.organization_id, organizationId), eq(sessions.task_id, taskId)))
				.orderBy(asc(sessions.id))
				.for('update')
		: []
	const queued = row
		? await tx
				.select()
				.from(queuedMessages)
				.where(
					and(
						eq(queuedMessages.organization_id, organizationId),
						or(
							eq(queuedMessages.task_id, taskId),
							siblings.length
								? inArray(
										queuedMessages.session_id,
										siblings.map((item) => item.id),
									)
								: undefined,
						),
					),
				)
				.orderBy(asc(queuedMessages.id))
				.for('update')
		: []
	return { task, row, siblings, queued }
}
export type ReviewBoundary = Awaited<ReturnType<typeof lockReviewTask>>

export function reviewQueueIsAdmitted(boundary: ReviewBoundary, sessionId: string, messageId: string) {
	const row = boundary.row
	if (!row) return true
	const message = boundary.queued.find((item) => item.id === messageId)
	return Boolean(
		message &&
		message.session_id === sessionId &&
		message.task_id === row.task_id &&
		message.organization_id === row.organization_id &&
		message.resource_owner_user_id === row.resource_owner_user_id &&
		message.user_id === row.resource_owner_user_id &&
		row.writer_receipts.some(
			(receipt) =>
				receipt.messageId === message.id &&
				receipt.sessionId === sessionId &&
				receipt.inputDigest === reviewDigest(message.content),
		),
	)
}

export async function lockReviewSession(tx: Executor, organizationId: string, sessionId: string) {
	const [hint] = await tx
		.select({ taskId: sessions.task_id })
		.from(sessions)
		.where(and(eq(sessions.organization_id, organizationId), eq(sessions.id, sessionId)))
	const boundary = hint?.taskId ? await lockReviewTask(tx, organizationId, hint.taskId) : null
	const [session] = await tx
		.select()
		.from(sessions)
		.where(and(eq(sessions.organization_id, organizationId), eq(sessions.id, sessionId)))
		.for('update')
	if (session && session.task_id !== hint?.taskId)
		rejectReview('Could not change this session. Its task changed; refresh before retrying.')
	return { boundary, session }
}

export const reviewIsIdle = (status: string) => ['draft', 'ready_for_input', 'interrupted'].includes(status)
export function assertReviewIdle(boundary: ReviewBoundary, except?: string) {
	if (
		boundary.row?.action_id ||
		boundary.siblings.some((item) => item.id !== except && !reviewIsIdle(item.status)) ||
		boundary.queued.some((item) => item.status === 'pending')
	)
		rejectReview('Could not start work. Reconcile active, queued, or uncertain work on this task first.')
}

export type ReviewWriterAdmission = { readonly taskId: string }
const admissions = new WeakMap<ReviewWriterAdmission, { tx: Executor; taskId: string }>()
export function assertReviewInsertion(tx: Executor, taskId: string, admission?: ReviewWriterAdmission) {
	const bound = admission && admissions.get(admission)
	if (!bound || bound.tx !== tx || bound.taskId !== taskId)
		rejectReview('Could not launch this session. Enrolled work requires task admission.')
}

export async function beginReviewWriter<T extends { text: string }>(
	tx: Executor,
	boundary: ReviewBoundary | null,
	input: {
		userId: string
		hostId: string
		sessionId: string
		eventId?: string
		messageId?: string
		kind: string
		request: T
		entry: WorkEntry
		continuing?: boolean
		internal?: boolean
	},
) {
	const row = boundary?.row,
		task = boundary?.task
	if (!row || !task) return null
	if (
		task.archived ||
		task.is_draft ||
		task.resource_owner_user_id !== input.userId ||
		row.resource_owner_user_id !== input.userId ||
		row.host_id !== input.hostId ||
		!row.verified_binding
	)
		rejectReview('Could not start work. Ask the task owner to reconcile its enrolled host and placement.')
	if (!input.eventId)
		rejectReview('Could not start work. Retain the session and event IDs before sending this request.')
	if (input.kind === 'v2.continue' && !input.messageId)
		rejectReview('Could not continue this session. Retain its message ID before sending this request.')
	const digest = reviewDigest({ kind: input.kind, actor: input.userId, request: input.request })
	const inputDigest = reviewDigest(input.request.text)
	const key = `${input.kind}:${input.eventId}`
	const receipt = row.writer_receipts.find(
		(item) =>
			item.key === key ||
			item.eventId === input.eventId ||
			(input.messageId && item.messageId === input.messageId) ||
			(!input.continuing && item.sessionId === input.sessionId),
	)
	if (receipt) {
		if (
			receipt.key !== key ||
			receipt.digest !== digest ||
			receipt.sessionId !== input.sessionId ||
			receipt.messageId !== (input.messageId ?? null)
		)
			rejectReview('Could not replay this request. Its retained IDs or content changed.')
		// Check both possible transports, including a queue row that has since drained.
		const events = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, receipt.eventId))
		const messages = receipt.messageId
			? await tx.select().from(queuedMessages).where(eq(queuedMessages.id, receipt.messageId))
			: []
		const evidence = [...events, ...messages]
		if (
			!evidence.length ||
			evidence.some(
				(item) =>
					item.session_id !== input.sessionId ||
					item.organization_id !== task.organization_id ||
					item.task_id !== task.id ||
					item.resource_owner_user_id !== row.resource_owner_user_id ||
					item.user_id !== input.userId ||
					reviewDigest(item.content) !== receipt.inputDigest,
			)
		)
			rejectReview('Could not reconcile this request. Its retained input evidence is missing or changed.')
		return { replay: receipt.result, admission: undefined, digest, inputDigest, key }
	}
	const [oldEvent] = await tx
		.select({ id: conversationEvents.id })
		.from(conversationEvents)
		.where(eq(conversationEvents.id, input.eventId))
	const [oldMessage] = input.messageId
		? await tx.select({ id: queuedMessages.id }).from(queuedMessages).where(eq(queuedMessages.id, input.messageId))
		: []
	if (
		oldEvent ||
		oldMessage ||
		(!input.continuing && boundary.siblings.some((item) => item.id === input.sessionId && item.status !== 'draft'))
	)
		rejectReview('Could not replay this request. Its receipt is unavailable; reconcile the existing work.')
	const existing = input.continuing ? boundary.siblings.find((item) => item.id === input.sessionId) : undefined
	reviewWorkEntry(input.entry, task.workflow_type, existing)
	if (
		input.continuing &&
		(!existing ||
			![
				'ready_for_input',
				'interrupted',
				'running',
				'needs_approval',
				'waiting_for_usage_limit',
				'launching',
				'resuming',
			].includes(existing.status))
	)
		rejectReview('Could not continue this session. Reconcile its execution state first.')
	if (input.entry.executionPhase !== undefined && input.continuing && (!existing || !reviewIsIdle(existing.status)))
		rejectReview('Could not change phase. Wait for this session to become idle before resuming work.')
	if (input.entry.executionPhase !== undefined && boundary.queued.some((item) => item.status === 'pending'))
		rejectReview('Could not change phase. Reconcile queued input before starting another phase.')
	if (
		row.action_id ||
		boundary.siblings.some(
			(item) => item.id !== (input.continuing ? input.sessionId : '') && !reviewIsIdle(item.status),
		) ||
		boundary.queued.some(
			(item) => item.status === 'pending' && (!input.continuing || item.session_id !== input.sessionId),
		)
	)
		rejectReview('Could not start work. Reconcile active, queued, or uncertain work on this task first.')
	if (input.internal && row.planning_suspended && input.entry.executionPhase !== null)
		rejectReview('Could not advance implementation. The task owner must authorize execution after planning.')
	if (
		row.planning_suspended &&
		input.entry.executionPhase === undefined &&
		(!existing || existing.execution_phase !== null)
	)
		rejectReview('Could not continue implementation. Select an authorized work phase after planning.')
	const admission = { taskId: task.id }
	admissions.set(admission, { tx, taskId: task.id })
	return { replay: null, admission, digest, inputDigest, key }
}

export async function finishReviewWriter(
	tx: Executor,
	boundary: ReviewBoundary | null,
	started: Awaited<ReturnType<typeof beginReviewWriter>>,
	input: {
		sessionId: string
		eventId?: string
		messageId?: string
		entry: WorkEntry
		result: Record<string, unknown>
	},
) {
	if (!boundary?.row || !started || started.replay) return
	if (!input.eventId) rejectReview('Could not retain session admission. Its event ID is missing.')
	const eventId = input.eventId
	const [session] = await tx.select().from(sessions).where(eq(sessions.id, input.sessionId))
	if (!session) rejectReview('Could not retain session admission. No session was created.')
	const row = boundary.row
	const executionDigest = reviewDigest(reviewExecutionPayload(session))
	const values: Partial<typeof reviewProgression.$inferInsert> = {
		writer_receipts: [
			...row.writer_receipts,
			{
				key: started.key,
				digest: started.digest,
				inputDigest: started.inputDigest,
				sessionId: input.sessionId,
				eventId,
				messageId: input.messageId ?? null,
				executionDigest,
				result: receiptResult(input.result),
			},
		].slice(-32),
		planning_suspended:
			input.entry.executionPhase === null
				? true
				: input.entry.executionPhase === 'implementation'
					? false
					: row.planning_suspended,
		stage: 'stopped',
		wake_revision: row.wake_revision + 1n,
		last_outcome: null,
	}
	if (['ready_for_launch', 'waiting_for_workspace', 'resuming'].includes(session.status))
		values.admitted_execution = { sessionId: input.sessionId, digest: executionDigest }
	await tx.update(reviewProgression).set(values).where(eq(reviewProgression.task_id, row.task_id))
}

export function reviewWorkEntry(
	entry: WorkEntry,
	workflow: string,
	existing?: Parameters<typeof validateWorkEntry>[2],
) {
	try {
		validateWorkEntry(entry, workflow, existing)
	} catch (error) {
		rejectReview(error instanceof Error ? error.message : 'Could not start work. Select a supported work phase.')
	}
	return workEntryValues(entry, BigInt(Date.now()))
}

export async function beginReviewWorkflow(
	tx: Executor,
	boundary: ReviewBoundary,
	userId: string,
	input: { taskId: string; workflowMutation?: { expectedRevision: string; mutationDigest: string } } & WorkflowPatch,
) {
	if (!boundary.row || !boundary.task || !Object.keys(workflowPatch(input)).length) return null
	const { row, task } = boundary
	if (task.resource_owner_user_id !== userId)
		rejectReview('Could not change workflow. Only the task owner can change enrolled execution controls.')
	const mutation = input.workflowMutation,
		patch = workflowPatch(input)
	if (
		!mutation ||
		mutation.mutationDigest !== reviewDigest(workflowMutationPayload(task.id, mutation.expectedRevision, patch))
	)
		rejectReview('Could not change workflow. Retain its exact patch and current revision before sending.')
	const receipt = row.workflow_mutation_receipts.find((item) => item.digest === mutation.mutationDigest)
	if (receipt) return { replay: receipt.result, mutation }
	if (task.workflow_revision.toString() !== mutation.expectedRevision)
		rejectReview(
			'Could not change workflow. Its revision changed; review the current settings before making a new request.',
		)
	assertReviewIdle(boundary)
	if (patch.autoAdvanceImplementationToPr === true)
		rejectReview('Could not change publication. Enrolled delivery publishes in the same session.')
	return { replay: null, mutation }
}

export async function finishReviewWorkflow(
	tx: Executor,
	boundary: ReviewBoundary,
	started: Awaited<ReturnType<typeof beginReviewWorkflow>>,
	result: { transactionId: string; success: boolean },
	patch: WorkflowPatch,
) {
	if (!boundary.row || !boundary.task || !started || started.replay) return
	const revision = boundary.task.workflow_revision + 1n
	await tx
		.update(tasks)
		.set({ workflow_revision: revision, auto_advance_implementation_to_pr: false })
		.where(eq(tasks.id, boundary.task.id))
	await tx
		.update(reviewProgression)
		.set({
			workflow_mutation_receipts: [
				...boundary.row.workflow_mutation_receipts,
				{
					digest: started.mutation.mutationDigest,
					expectedRevision: started.mutation.expectedRevision,
					revision: revision.toString(),
					result,
				},
			].slice(-32),
			planning_suspended:
				typeof patch.workflowType === 'string'
					? patch.workflowType !== 'oneshot'
					: boundary.row.planning_suspended,
			stage: 'stopped',
			wake_revision: boundary.row.wake_revision + 1n,
			last_outcome: null,
		})
		.where(eq(reviewProgression.task_id, boundary.task.id))
}

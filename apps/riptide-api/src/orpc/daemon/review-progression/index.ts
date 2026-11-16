import { createHash } from 'node:crypto'

import { artifacts } from '@humanlayer/db/tables/artifacts'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { reviewProgression, type ReviewProgression } from '@humanlayer/db/tables/review-progression'
import { sessions } from '@humanlayer/db/tables/sessions'
import { taskWorkspaceSetupForHost } from '@humanlayer/db/tables/task-workspace-setup-for-host'
import { tasks } from '@humanlayer/db/tables/tasks'
import { workspaceLocationsForUserForHost as locations } from '@humanlayer/db/tables/workspace-locations-for-user-for-host'
import { workspaceRepositoryStatusForUserForHost as repositoryStatuses } from '@humanlayer/db/tables/workspace-repository-status-for-user-for-host'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import {
	ReviewProgressionPlacementSchema,
	ReviewScopeInputsSchema,
	REVIEW_TASK_SCOPE_FIELDS,
	type ReviewOutcome,
} from '@humanlayer/db/zodschemas/review-progression'
import { ReviewProgressionSnapshotSchema } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import {
	canonicalReviewValue,
	reviewExecutionPayload,
	reviewHelperScope,
	reviewDeliveryContext,
	reviewDeliveryContextFile,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import {
	ReviewHandoffSchema,
	ReviewPassiveNoteSchema,
	mergeOutcomeIdentity,
	reviewReportStatus,
} from '@humanlayer/riptide-api-contract/lib/review-reporting'
import { and, eq, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { hash } from 'ohash'

import type { DaemonAuthContext } from '../../../auth/context'
import { reviewDigest, lockReviewTask, reviewIsIdle } from '../../../db/review-progression'
import { daemonBase } from '../../base'

type Executor = PgDatabase<PostgresJsQueryResultHKT>
const candidate = (status: string) => ['ready_for_launch', 'waiting_for_workspace', 'resuming'].includes(status)

async function databaseNow(tx: Executor) {
	const result = await tx.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`)
	const value = result[0]?.now
	if (typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number')
		throw new Error('Database time unavailable')
	return BigInt(value)
}

function validClaim(
	row: ReviewProgression | null | undefined,
	auth: DaemonAuthContext,
	input: { claimId: string; generation: string },
	now: bigint,
) {
	return (
		!!row &&
		row.organization_id === auth.organizationId &&
		row.host_id === auth.hostId &&
		row.resource_owner_user_id === auth.userId &&
		row.claim_id === input.claimId &&
		row.claim_generation.toString() === input.generation &&
		row.claim_expires_at !== null &&
		row.claim_expires_at > now
	)
}

function validOutcome(row: ReviewProgression, outcome: ReviewOutcome) {
	const context = outcome.context
	if (!context) return outcome.status === 'needs_decision' && outcome.continuation.kind === 'stop'
	if (
		!row.verified_binding ||
		context.taskId !== row.task_id ||
		context.repository !== row.verified_binding.repository ||
		context.scopeSha256 !== reviewDigest(reviewHelperScope(row.scope_inputs, row.verified_binding))
	)
		return false
	if (row.verified_pr_binding && (context.pr !== row.verified_pr_binding.pr || context.headSha === null)) return false
	if (outcome.continuation.kind === 'wait') {
		const { nextWakeAt, actionId } = outcome.continuation
		if (!Number.isSafeInteger(Date.parse(nextWakeAt))) return false
		if (
			actionId &&
			actionId !== row.source_session_id &&
			!row.writer_receipts.some((receipt) => receipt.sessionId === actionId)
		)
			return false
	}
	return true
}

async function admission(tx: Executor, sessionId: string, auth: DaemonAuthContext, progression = false) {
	const [session] = await tx
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.organization_id, auth.organizationId),
				eq(sessions.host_id, auth.hostId),
				eq(sessions.created_by, auth.userId),
			),
		)
		.limit(1)
	if (!session)
		return {
			kind: 'blocked' as const,
			reason: 'Could not verify session ownership. Reconcile the selected host and task.',
		}
	const [hint] = await tx
		.select()
		.from(reviewProgression)
		.where(
			or(
				eq(reviewProgression.source_session_id, session.id),
				session.task_id ? eq(reviewProgression.task_id, session.task_id) : undefined,
			),
		)
		.limit(1)
	if (!hint) return { kind: 'not_enrolled' as const }
	const boundary = await lockReviewTask(tx, auth.organizationId, hint.task_id)
	const row = boundary.row
	if (!row)
		return {
			kind: 'blocked' as const,
			reason: 'Could not verify enrollment. Reconcile this task before starting work.',
		}
	const block = (reason: string) => ({ kind: 'blocked' as const, reason })
	if (row.task_id !== session.task_id)
		return block('Could not verify the source task. Restore its accepted task before launching.')
	const [task] = await tx
		.select()
		.from(tasks)
		.where(and(eq(tasks.id, row.task_id), eq(tasks.organization_id, auth.organizationId)))
		.limit(1)
	if (
		!task ||
		task.archived ||
		task.is_draft ||
		task.resource_owner_user_id !== auth.userId ||
		row.resource_owner_user_id !== auth.userId ||
		row.organization_id !== auth.organizationId ||
		row.host_id !== auth.hostId ||
		(!progression && !candidate(session.status))
	)
		return block(
			'Could not admit this launch. Reconcile the existing task and source session before starting work.',
		)
	const current = boundary.siblings.find((item) => item.id === session.id)
	if (
		!current ||
		reviewDigest(reviewExecutionPayload(current)) !== reviewDigest(reviewExecutionPayload(session)) ||
		(!progression &&
			((row.action_id !== null && row.action_id !== session.id) ||
				boundary.siblings.some((item) => item.id !== session.id && !reviewIsIdle(item.status))))
	)
		return block('Could not admit this session. Reconcile competing or changed work on this task.')
	const receipt = row.writer_receipts.findLast((item) => item.sessionId === session.id)
	const originalLaunch = row.source_session_id === session.id && !receipt
	// Progression observes the source after runtime fields change; it does not admit a session launch.
	if (
		!originalLaunch &&
		(!receipt ||
			!row.verified_binding ||
			(!progression &&
				!(
					row.admitted_execution?.sessionId === session.id &&
					row.admitted_execution.digest === reviewDigest(reviewExecutionPayload(session))
				)))
	)
		return block('Could not admit this session. Its retained execution request is missing or changed.')
	const source = boundary.siblings.find((item) => item.id === row.source_session_id)
	if (!source) return block('Could not verify the original delivery source. Reconcile the existing task.')
	const placement = ReviewProgressionPlacementSchema.parse(row.placement)
	const scopeInputs = ReviewScopeInputsSchema.parse(row.scope_inputs)
	if (
		canonicalReviewValue(scopeInputs.task) !==
			canonicalReviewValue(Object.fromEntries(REVIEW_TASK_SCOPE_FIELDS.map((key) => [key, task[key]]))) ||
		canonicalReviewValue(scopeInputs.placement) !== canonicalReviewValue(placement)
	)
		return block('Could not verify the accepted scope. Restore the accepted task before launching.')
	if (
		placement.projectId !== task.project_id ||
		placement.workspaceId !== task.workspace_id ||
		row.accepted_launch_digest !== reviewDigest(row.accepted_launch)
	)
		return block('Could not verify the accepted placement. Restore the accepted task inputs before launching.')
	const accepted = row.accepted_launch
	const first = accepted.firstSession
	if (
		first === null ||
		typeof first !== 'object' ||
		!('text' in first) ||
		(originalLaunch && session.prompt !== first.text) ||
		task.ticket_description !== (accepted.ticketDescription ?? null) ||
		task.auto_advance_implementation_to_pr
	)
		return block('Could not verify the accepted task. Its description or delivery settings changed.')
	const launchSession = first as Record<string, unknown>
	if (
		originalLaunch &&
		(session.effort !== (launchSession.effort ?? null) ||
			session.fast_mode !== (launchSession.fastMode ?? false) ||
			session.forked_from_session_id !== null ||
			session.handoff_source_session_id !== null ||
			session.fork_data !== null ||
			(!progression && session.coding_agent_session_id !== null) ||
			session.workflow_type !== null)
	)
		return block(
			'Could not verify the accepted execution settings. Reconcile the existing session before launching.',
		)
	if (
		session.archived ||
		session.resource_owner_user_id !== auth.userId ||
		(originalLaunch &&
			['codingAgent', 'provider', 'model', 'permissionsMode'].some(
				(key) =>
					({
						codingAgent: session.coding_agent,
						provider: session.provider,
						model: session.model,
						permissionsMode: session.permissions_mode,
					})[key as 'codingAgent' | 'provider' | 'model' | 'permissionsMode'] !== launchSession[key],
			))
	)
		return block(
			'Could not verify the accepted execution settings. Reconcile the existing session before launching.',
		)
	if (row.verified_binding && session.working_directory !== row.verified_binding.workingDirectory)
		return block('Could not verify this directory. Keep enrolled sessions in the confirmed checkout.')
	const acceptedArtifacts = await tx
		.select()
		.from(artifacts)
		.where(and(eq(artifacts.task_id, task.id), eq(artifacts.organization_id, auth.organizationId)))
	for (const expected of scopeInputs.artifacts) {
		const found = acceptedArtifacts.filter((item) => item.file_name === expected.fileName)
		const item = found[0]
		if (
			found.length !== 1 ||
			!item ||
			item.is_deleted ||
			item.resource_owner_user_id !== auth.userId ||
			item.storage_type !== expected.storageType ||
			item.content_hash !== expected.contentHash ||
			item.content_type !== expected.contentType ||
			Number(item.file_size_bytes) !== expected.fileSizeBytes ||
			(item.storage_type === 'postgres' &&
				createHash('sha256').update(item.content).digest('hex') !== expected.bytesSha256)
		)
			return block(
				'Could not verify an accepted file. Restore the accepted ticket and attachments before launching.',
			)
	}
	if (
		scopeInputs.accepted !== accepted.acceptedTaskArtifact ||
		canonicalReviewValue(scopeInputs.artifacts) !== canonicalReviewValue(accepted.acceptedArtifacts)
	)
		return block('Could not verify the accepted task artifact. Restore its accepted content before launching.')
	const scopeSha256 = row.verified_binding ? reviewDigest(reviewHelperScope(scopeInputs, row.verified_binding)) : null
	if (scopeSha256 !== null) {
		const contextArtifact = acceptedArtifacts.find(
			(item) => item.file_name === reviewDeliveryContextFile(row.source_session_id),
		)
		if (
			!contextArtifact ||
			contextArtifact.is_deleted ||
			contextArtifact.storage_type !== 'postgres' ||
			contextArtifact.content !==
				canonicalReviewValue(
					reviewDeliveryContext({
						taskId: task.id,
						sourceSessionId: row.source_session_id,
						acceptedLaunchDigest: row.accepted_launch_digest,
						scopeSha256,
					}),
				)
		)
			return block(
				'Could not verify delivery instructions. Restore the accepted delivery context before launching.',
			)
	}
	let repositories = null
	let setupComplete = false
	if (placement.kind === 'project_workspace') {
		const [workspace] = await tx
			.select()
			.from(workspaces)
			.where(
				and(
					eq(workspaces.id, placement.workspaceId),
					eq(workspaces.project_id, placement.projectId),
					eq(workspaces.organization_id, auth.organizationId),
				),
			)
			.limit(1)
		if (
			!workspace ||
			workspace.archived ||
			workspace.resource_owner_user_id !== auth.userId ||
			task.default_working_directory !== session.working_directory ||
			workspace.repositories.length !== 1 ||
			canonicalReviewValue(workspace.repositories) !== canonicalReviewValue(accepted.repositories)
		)
			return block('Could not verify the repository recipe. Restore the accepted workspace before launching.')
		repositories = workspace.repositories
		const [location] = await tx
			.select()
			.from(locations)
			.where(
				and(
					eq(locations.workspace_id, workspace.id),
					eq(locations.project_id, workspace.project_id),
					eq(locations.organization_id, auth.organizationId),
					eq(locations.user_id, auth.userId),
					eq(locations.host_id, auth.hostId),
				),
			)
			.limit(1)
		const statuses = await tx
			.select()
			.from(repositoryStatuses)
			.where(
				and(
					eq(repositoryStatuses.workspace_id, workspace.id),
					eq(repositoryStatuses.project_id, workspace.project_id),
					eq(repositoryStatuses.organization_id, auth.organizationId),
					eq(repositoryStatuses.user_id, auth.userId),
					eq(repositoryStatuses.host_id, auth.hostId),
				),
			)
		const status = statuses[0]
		const repository = workspace.repositories[0]
		setupComplete = Boolean(
			repository &&
			location &&
			location.setup_generation > 0n &&
			statuses.length === 1 &&
			status &&
			status.generation === location.setup_generation &&
			status.repository_identity === repository.repositoryIdentity &&
			status.status === 'done' &&
			status.error === null &&
			status.materialization?.path === session.working_directory &&
			status.materialization.branch === repository.branch,
		)
	} else {
		const [setup] = await tx
			.select()
			.from(taskWorkspaceSetupForHost)
			.where(
				and(
					eq(taskWorkspaceSetupForHost.id, placement.setupRowId),
					eq(taskWorkspaceSetupForHost.task_id, task.id),
					eq(taskWorkspaceSetupForHost.organization_id, auth.organizationId),
					eq(taskWorkspaceSetupForHost.host_id, auth.hostId),
				),
			)
			.limit(1)
		if (
			!setup ||
			(task.workspace_spec === null
				? placement.workspaceSpecDigest !== null
				: reviewDigest(task.workspace_spec) !== placement.workspaceSpecDigest) ||
			canonicalReviewValue(setup.resolved_workspace_spec) !== canonicalReviewValue(task.workspace_spec)
		)
			return block('Could not verify workspace setup. Its accepted repository or branch changed.')
		if (
			(originalLaunch && session.working_directory !== launchSession.workingDirectory) ||
			task.default_working_directory !== accepted.defaultWorkingDirectory
		)
			return block('Could not verify the accepted directory. Restore its launch placement before starting work.')
		const spec = task.workspace_spec
		setupComplete =
			setup.status === 'done' &&
			setup.error === null &&
			(spec === null
				? setup.workspace_setup_state.repos.length === 0
				: setup.workspace_setup_state.specVersion === spec.specVersion &&
					setup.workspace_setup_state.repos.length === spec.repos.length &&
					setup.workspace_setup_state.repos.every(
						(repo) =>
							repo.status === 'done' &&
							spec.repos.some((expected) => expected.localPath === repo.localPath),
					))
	}
	return {
		kind: 'enrolled' as const,
		snapshot: ReviewProgressionSnapshotSchema.parse({
			taskId: task.id,
			sourceSessionId: row.source_session_id,
			executionSessionId: session.id,
			organizationId: auth.organizationId,
			ownerUserId: auth.userId,
			hostId: auth.hostId,
			enrollment: { enrollmentId: row.enrollment_id, returnRouteRef: row.return_route_ref },
			placement,
			acceptedLaunchDigest: row.accepted_launch_digest,
			executionDigest: reviewDigest(reviewExecutionPayload(session)),
			workingDirectory: session.working_directory,
			scopeInputs,
			scopeSha256,
			sourceCreatedAtMs: Number(source.created_at),
			repositories,
			workspaceSpec: task.workspace_spec,
			setupComplete,
			verifiedBinding: row.verified_binding,
			bindingDigest: row.binding_digest,
		}),
	}
}

export function freshReviewReportOutcome(row: ReviewProgression) {
	return !row.planning_suspended &&
		row.stage === 'stopped' &&
		row.continuation.kind === 'stop' &&
		row.wake_revision === row.consumed_revision &&
		row.last_ack?.revision === row.wake_revision.toString() &&
		row.last_outcome &&
		row.last_ack.digest === reviewDigest(row.last_outcome) &&
		validOutcome(row, row.last_outcome)
		? row.last_outcome
		: null
}

export const reviewProgressionProcedures = {
	reports: daemonBase.reviewProgression.reports.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			const { row, task, siblings } = await lockReviewTask(tx, context.auth.organizationId, input.taskId)
			if (
				!row ||
				row.host_id !== context.auth.hostId ||
				row.resource_owner_user_id !== context.auth.userId ||
				task?.resource_owner_user_id !== context.auth.userId
			)
				throw errors.FORBIDDEN()
			const value = await admission(tx, row.source_session_id, context.auth, true)
			if (value.kind !== 'enrolled') throw errors.FORBIDDEN()
			return {
				snapshot: value.snapshot,
				codingAgentSessionId:
					siblings.find((session) => session.id === row.source_session_id)?.coding_agent_session_id ?? null,
				outcome: freshReviewReportOutcome(row),
				wakeRevision: row.wake_revision.toString(),
				planningSuspended: row.planning_suspended,
				receipts: row.report_receipts,
			}
		}),
	),
	claim: daemonBase.reviewProgression.claim.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			const boundary = await lockReviewTask(tx, context.auth.organizationId, input.taskId)
			const row = boundary.row
			if (
				!row ||
				row.host_id !== context.auth.hostId ||
				row.resource_owner_user_id !== context.auth.userId ||
				boundary.task?.resource_owner_user_id !== context.auth.userId
			)
				throw errors.FORBIDDEN()
			const now = await databaseNow(tx)
			if (row.wake_revision.toString() !== input.expectedWakeRevision) return { kind: 'stale' as const }
			const same = row.claim_id === input.claimId
			if (row.claim_id && row.claim_expires_at !== null && row.claim_expires_at > now && !same)
				return { kind: 'busy' as const }
			if (same && (row.claim_expires_at === null || row.claim_expires_at <= now))
				return { kind: 'stale' as const }
			if (row.planning_suspended || boundary.task?.archived || boundary.task?.is_draft)
				return { kind: 'stopped' as const }
			if (
				!same &&
				row.consumed_revision >= row.wake_revision &&
				row.continuation.kind !== 'reconcile' &&
				(row.next_wake_at === null || row.next_wake_at > now)
			)
				return { kind: 'stopped' as const }
			const admitted = await admission(tx, row.source_session_id, context.auth, true)
			if (admitted.kind !== 'enrolled' || !admitted.snapshot.verifiedBinding || !admitted.snapshot.setupComplete)
				return { kind: 'blocked' as const }
			const generation = same ? row.claim_generation : row.claim_generation + 1n
			const expiry = same ? (row.claim_expires_at ?? now) : now + 60_000n
			if (!same)
				await tx
					.update(reviewProgression)
					.set({
						claim_id: input.claimId,
						claim_generation: generation,
						claimed_revision: row.wake_revision,
						claim_expires_at: expiry,
					})
					.where(eq(reviewProgression.task_id, row.task_id))
			return {
				kind: 'claimed' as const,
				generation: generation.toString(),
				claimedRevision: (same ? (row.claimed_revision ?? row.wake_revision) : row.wake_revision).toString(),
				expiresAt: expiry.toString(),
				reconciliationRequired: generation > 1n,
				snapshot: admitted.snapshot,
				prBinding: row.verified_pr_binding,
			}
		}),
	),
	renew: daemonBase.reviewProgression.renew.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			const { row, task } = await lockReviewTask(tx, context.auth.organizationId, input.taskId)
			const now = await databaseNow(tx)
			if (
				!validClaim(row, context.auth, input, now) ||
				task?.resource_owner_user_id !== context.auth.userId ||
				task.archived ||
				task.is_draft ||
				row?.planning_suspended
			)
				throw errors.FORBIDDEN()
			const expiresAt = now + 60_000n
			await tx
				.update(reviewProgression)
				.set({ claim_expires_at: expiresAt })
				.where(eq(reviewProgression.task_id, input.taskId))
			return { expiresAt: expiresAt.toString() }
		}),
	),
	ack: daemonBase.reviewProgression.ack.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			const boundary = await lockReviewTask(tx, context.auth.organizationId, input.taskId),
				row = boundary.row
			if (
				!row ||
				row.host_id !== context.auth.hostId ||
				row.resource_owner_user_id !== context.auth.userId ||
				boundary.task?.resource_owner_user_id !== context.auth.userId
			)
				throw errors.FORBIDDEN()
			if (row.last_ack?.claimId === input.claimId && row.last_ack.generation === input.generation) {
				if (
					row.last_ack.digest !== input.resultDigest ||
					row.last_ack.revision !== input.claimedRevision ||
					reviewDigest(input.validatedOutcome) !== input.resultDigest
				)
					throw errors.FORBIDDEN()
				return { acknowledged: true as const }
			}
			if (
				!validClaim(row, context.auth, input, await databaseNow(tx)) ||
				row.claimed_revision?.toString() !== input.claimedRevision ||
				reviewDigest(input.validatedOutcome) !== input.resultDigest ||
				!validOutcome(row, input.validatedOutcome)
			)
				throw errors.FORBIDDEN()
			const newer = row.wake_revision > BigInt(input.claimedRevision)
			const outcome = input.validatedOutcome
			const patch: Partial<typeof reviewProgression.$inferInsert> = {
				last_ack: {
					claimId: input.claimId,
					generation: input.generation,
					revision: input.claimedRevision,
					digest: input.resultDigest,
				},
				last_outcome: outcome,
				consumed_revision: BigInt(input.claimedRevision),
				claim_id: null,
				claimed_revision: null,
				claim_expires_at: null,
			}
			if (outcome.continuation.kind === 'wait' && outcome.continuation.actionId && !row.action_id)
				patch.action_id = outcome.continuation.actionId
			if (!newer && !row.planning_suspended)
				Object.assign(patch, {
					continuation: outcome.continuation,
					next_wake_at:
						outcome.continuation.kind === 'wait'
							? BigInt(Date.parse(outcome.continuation.nextWakeAt))
							: null,
					action_id:
						outcome.status === 'needs_decision'
							? row.action_id
							: outcome.continuation.kind === 'wait'
								? (outcome.continuation.actionId ?? null)
								: null,
					stage:
						outcome.continuation.kind === 'stop'
							? 'stopped'
							: row.verified_pr_binding
								? 'reviewing'
								: 'awaiting_delivery',
				})
			await tx.update(reviewProgression).set(patch).where(eq(reviewProgression.task_id, input.taskId))
			return { acknowledged: true as const }
		}),
	),
	recordDelivery: daemonBase.reviewProgression.recordDelivery.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			const boundary = await lockReviewTask(tx, context.auth.organizationId, input.taskId),
				row = boundary.row
			if ('kind' in input) {
				const request = input.request
				if (
					!row ||
					row.host_id !== context.auth.hostId ||
					row.resource_owner_user_id !== context.auth.userId ||
					boundary.task?.resource_owner_user_id !== context.auth.userId ||
					input.sourceSessionId !== row.source_session_id ||
					!row.verified_binding ||
					request.enrollmentId !== row.enrollment_id ||
					request.repository !== row.verified_binding.repository ||
					request.scopeSha256 !== reviewDigest(reviewHelperScope(row.scope_inputs, row.verified_binding)) ||
					request.requestId !==
						reviewDigest({
							enrollmentId: request.enrollmentId,
							outcomeKey: request.outcomeKey,
							repository: request.repository,
							pr: request.pr,
							headSha: request.headSha,
							scopeSha256: request.scopeSha256,
						})
				)
					throw errors.FORBIDDEN()
				if (request.kind === 'merge_result') {
					if (request.outcomeKey !== reviewDigest(mergeOutcomeIdentity(request))) throw errors.FORBIDDEN()
					const parentReceipt = row.report_receipts.find(
						(item) => item.requestId === request.parentRequestId && item.destinationSlot === 'artifact',
					)
					if (!parentReceipt) throw errors.FORBIDDEN()
					const [parentArtifact] = await tx
						.select()
						.from(artifacts)
						.where(
							and(
								eq(artifacts.id, parentReceipt.receiptIdentity),
								eq(artifacts.organization_id, context.auth.organizationId),
								eq(artifacts.task_id, row.task_id),
							),
						)
					if (
						!parentArtifact ||
						parentArtifact.is_deleted ||
						parentArtifact.storage_type !== 'postgres' ||
						parentArtifact.resource_owner_user_id !== context.auth.userId ||
						parentArtifact.file_name !== `review-report-${parentReceipt.outcomeKey}.md` ||
						createHash('sha256').update(parentArtifact.content).digest('hex') !==
							parentReceipt.contentDigest
					)
						throw errors.FORBIDDEN()
					let parent
					try {
						parent = ReviewHandoffSchema.parse(JSON.parse(parentArtifact.content.split('\n\n')[1] ?? ''))
					} catch {
						throw errors.FORBIDDEN()
					}
					if (
						parent.kind !== 'readiness' ||
						parent.requestId !== request.parentRequestId ||
						parent.outcomeKey !== parentReceipt.outcomeKey ||
						parent.enrollmentId !== request.enrollmentId ||
						parent.repository !== request.repository ||
						parent.pr !== request.pr ||
						parent.headSha !== request.headSha ||
						parent.scopeSha256 !== request.scopeSha256
					)
						throw errors.FORBIDDEN()
				}
				let content: string
				if (input.destinationSlot === 'origin_session') {
					const [event] = await tx
						.select()
						.from(conversationEvents)
						.where(
							and(
								eq(conversationEvents.id, input.receiptIdentity),
								eq(conversationEvents.organization_id, context.auth.organizationId),
							),
						)
					const source = boundary.siblings.find((session) => session.id === row.source_session_id)
					if (
						!event ||
						!source?.coding_agent_session_id ||
						event.session_id !== row.source_session_id ||
						event.task_id !== row.task_id ||
						event.event_type !== 'system' ||
						event.role !== 'system' ||
						event.coding_agent_session_id !== source.coding_agent_session_id ||
						event.resource_owner_user_id !== context.auth.userId ||
						!event.content
					)
						throw errors.FORBIDDEN()
					content = event.content
					const expected = ReviewPassiveNoteSchema.parse({
						kind: 'review_progression',
						version: 1,
						outcomeKey: request.outcomeKey,
						status: reviewReportStatus(request, input.deliveryStatus),
						repository: request.repository,
						pr: request.pr,
						headSha: request.headSha,
						reportArtifact: `review-report-${request.outcomeKey}.md`,
					})
					if (content !== canonicalReviewValue(expected)) throw errors.FORBIDDEN()
				} else {
					const [artifact] = await tx
						.select()
						.from(artifacts)
						.where(
							and(
								eq(artifacts.id, input.receiptIdentity),
								eq(artifacts.organization_id, context.auth.organizationId),
								eq(artifacts.task_id, row.task_id),
							),
						)
					if (
						!artifact ||
						artifact.is_deleted ||
						artifact.storage_type !== 'postgres' ||
						artifact.resource_owner_user_id !== context.auth.userId ||
						artifact.file_name !== `review-report-${request.outcomeKey}.md` ||
						!artifact.content.startsWith(`# Review report\n\n${canonicalReviewValue(request)}\n\n`)
					)
						throw errors.FORBIDDEN()
					content = artifact.content
				}
				if (createHash('sha256').update(content).digest('hex') !== input.contentDigest) throw errors.FORBIDDEN()
				const receipt = {
					requestId: request.requestId,
					outcomeKey: request.outcomeKey,
					destinationSlot: input.destinationSlot,
					receiptIdentity: input.receiptIdentity,
					contentDigest: input.contentDigest,
				}
				const previous = row.report_receipts.find(
					(item) => item.requestId === request.requestId && item.destinationSlot === input.destinationSlot,
				)
				if (previous) {
					if (canonicalReviewValue(previous) !== canonicalReviewValue(receipt)) throw errors.FORBIDDEN()
					return previous
				}
				if (row.report_receipts.length >= 64) throw errors.FORBIDDEN()
				await tx
					.update(reviewProgression)
					.set({ report_receipts: [...row.report_receipts, receipt] })
					.where(eq(reviewProgression.task_id, row.task_id))
				return receipt
			}
			if (
				!validClaim(row, context.auth, input, await databaseNow(tx)) ||
				!row ||
				boundary.task?.resource_owner_user_id !== context.auth.userId ||
				row.claimed_revision?.toString() !== input.claimedRevision ||
				(row.wake_revision.toString() !== input.claimedRevision && !row.verified_pr_binding) ||
				row.planning_suspended ||
				reviewDigest(input.validatedOutcome) !== input.resultDigest ||
				!validOutcome(row, input.validatedOutcome) ||
				input.validatedOutcome.status !== 'delivery_observed' ||
				!row.verified_binding
			)
				throw errors.FORBIDDEN()
			const b = input.binding,
				c = input.validatedOutcome.context
			if (
				!c ||
				b.repository !== row.verified_binding.repository ||
				b.branch !== row.verified_binding.branch ||
				b.sourceSessionId !== row.source_session_id ||
				b.scopeSha256 !== c.scopeSha256 ||
				b.headSha !== c.headSha ||
				b.pr !== c.pr ||
				(row.verified_pr_binding && canonicalReviewValue(row.verified_pr_binding) !== canonicalReviewValue(b))
			)
				throw errors.FORBIDDEN()
			const admitted = await admission(tx, row.source_session_id, context.auth, true)
			const source = boundary.siblings.find((session) => session.id === row.source_session_id)
			if (
				admitted.kind !== 'enrolled' ||
				source?.status !== 'ready_for_input' ||
				!admitted.snapshot.setupComplete ||
				boundary.queued.some((message) => message.status === 'pending') ||
				boundary.siblings.some((session) => !reviewIsIdle(session.status))
			)
				throw errors.FORBIDDEN()
			if (row.verified_pr_binding) return b
			await tx
				.update(reviewProgression)
				.set({
					verified_pr_binding: b,
					stage: 'reviewing',
					wake_revision: row.wake_revision + 1n,
					continuation: { kind: 'reconcile', progressKey: input.resultDigest },
					next_wake_at: null,
				})
				.where(eq(reviewProgression.task_id, input.taskId))
			if (source.execution_phase !== 'review')
				await tx
					.update(sessions)
					.set({ execution_phase: 'review', execution_phase_at: await databaseNow(tx) })
					.where(eq(sessions.id, row.source_session_id))
			return b
		}),
	),
	admission: daemonBase.reviewProgression.admission.handler(async ({ input, context }) =>
		context.services.db.transaction((tx) => admission(tx, input.sessionId, context.auth)),
	),
	confirmPlacement: daemonBase.reviewProgression.confirmPlacement.handler(async ({ input, context, errors }) =>
		context.services.db.transaction(async (tx) => {
			// The task is the first lock for every enrolled launch transition.
			const { row } = await lockReviewTask(tx, context.auth.organizationId, input.taskId)
			const admitted = await admission(tx, input.sourceSessionId, context.auth)
			if (
				!row ||
				admitted.kind !== 'enrolled' ||
				admitted.snapshot.taskId !== input.taskId ||
				!admitted.snapshot.setupComplete ||
				row.accepted_launch_digest !== input.acceptedLaunchDigest ||
				reviewDigest(input.binding) !== input.bindingDigest
			)
				throw errors.FORBIDDEN()
			if (row.verified_binding !== null) {
				if (
					row.binding_digest !== input.bindingDigest ||
					canonicalReviewValue(row.verified_binding) !== canonicalReviewValue(input.binding)
				)
					throw errors.FORBIDDEN()
				return row.verified_binding
			}
			await tx
				.update(reviewProgression)
				.set({
					verified_binding: input.binding,
					binding_digest: input.bindingDigest,
					updated_at: BigInt(Date.now()),
				})
				.where(eq(reviewProgression.task_id, input.taskId))
			const content = canonicalReviewValue(
				reviewDeliveryContext({
					...admitted.snapshot,
					scopeSha256: reviewDigest(reviewHelperScope(admitted.snapshot.scopeInputs, input.binding)),
				}),
			)
			const fileName = reviewDeliveryContextFile(input.sourceSessionId)
			await tx
				.insert(artifacts)
				.values({
					task_id: input.taskId,
					task_slug: admitted.snapshot.scopeInputs.task.slug,
					organization_id: context.auth.organizationId,
					resource_owner_user_id: context.auth.userId,
					created_by: context.auth.userId,
					file_name: fileName,
					content,
					content_hash: hash(content),
					content_type: 'application/json',
					file_size_bytes: BigInt(Buffer.byteLength(content)),
					storage_type: 'postgres',
				})
				.onConflictDoNothing()
			const [retained] = await tx
				.select()
				.from(artifacts)
				.where(and(eq(artifacts.task_id, input.taskId), eq(artifacts.file_name, fileName)))
			if (
				!retained ||
				retained.organization_id !== context.auth.organizationId ||
				retained.is_deleted ||
				retained.storage_type !== 'postgres' ||
				retained.content !== content
			)
				throw errors.FORBIDDEN()
			// The existing task subscription rechecks deferred launches; no review dispatcher is installed.
			await tx
				.update(tasks)
				.set({ updated_at: BigInt(Date.now()) })
				.where(eq(tasks.id, input.taskId))
			return input.binding
		}),
	),
}

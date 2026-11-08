import { isEffortSupported, isFastModeSupported } from '@humanlayer/ai/config'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { sessions } from '@humanlayer/db/tables/sessions'
import { ContinueSessionOutputSchema } from '@humanlayer/riptide-api-contract/api/sessions/continue'
import { ORPCError } from '@orpc/server'
import { and, eq, sql } from 'drizzle-orm'

import { getTxId } from '../../../db/get-tx-id'
import {
	lockReviewSession,
	beginReviewWriter,
	finishReviewWriter,
	reviewWorkEntry,
} from '../../../db/review-progression'
import { tryEnsureSessionStreamHydrated } from '../../../effects/services/durable-streams/streams'
import {
	getSessionAccessControlLevelForClassicProcedure,
	hasRequiredSessionAccess,
	SessionAccessControl,
} from '../../../lib/session-multiplayer-prompting-auth'
import logger from '../../../logger'
import { apiBaseOrgRequired, requiresBillingMiddleware } from '../../base'

/**
 * Continue an existing session with a new user message
 *
 * Authorization: User must be session creator AND have edit access (via task ACL or session ownership if no task)
 * Precondition: Session must be in 'ready_for_input', 'interrupted', or 'failed' status
 */
export const continueSessionProcedure = apiBaseOrgRequired.sessions.continue
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		const { sessionId, eventId, text, model, effort, fastMode, permissionsMode } = input
		const { services } = context
		const { db } = services
		const nowMillis = Date.now()

		try {
			const txResult = await db.transaction(async (tx) => {
				const locked = await lockReviewSession(tx, context.auth.organizationId, sessionId)
				// Fetch the session first to check authorization
				const [session] = await tx
					.select({
						id: sessions.id,
						task_id: sessions.task_id,
						resource_owner_user_id: sessions.resource_owner_user_id,
						created_by: sessions.created_by,
						status: sessions.status,
						coding_agent: sessions.coding_agent,
						provider: sessions.provider,
						model: sessions.model,
						effort: sessions.effort,
						fast_mode: sessions.fast_mode,
					})
					.from(sessions)
					.where(and(eq(sessions.id, sessionId), eq(sessions.organization_id, context.auth.organizationId)))
					.limit(1)
					.for('no key update')

				if (!session || !locked.session) {
					throw errors.NOT_FOUND({ data: { message: 'Session not found' } })
				}

				// Check write permission: user must be session creator AND have task ACL edit (or own standalone session)
				const accessLevel = await getSessionAccessControlLevelForClassicProcedure(
					tx,
					{
						organizationId: context.auth.organizationId,
						sessionId,
						actorUserId: context.auth.userId,
					},
					nowMillis,
				)
				if (!hasRequiredSessionAccess(accessLevel, SessionAccessControl.prompt)) {
					throw errors.FORBIDDEN({ data: { message: 'Write permission required on session' } })
				}
				const started = await beginReviewWriter(tx, locked.boundary, {
					userId: context.auth.userId,
					hostId: locked.session.host_id,
					sessionId,
					eventId,
					kind: 'legacy.continue',
					request: input,
					entry: input,
					continuing: true,
				})
				if (started?.replay) {
					const retained = ContinueSessionOutputSchema.parse(started.replay)
					return { success: retained.success, txid: retained.transactionId }
				}
				if (!['ready_for_input', 'interrupted', 'failed', 'lost'].includes(session.status))
					throw errors.BAD_REQUEST({ data: { message: 'Session is not ready for input' } })
				if (input.executionPhase !== undefined && !['ready_for_input', 'interrupted'].includes(session.status))
					throw errors.BAD_REQUEST({
						data: {
							message: 'Could not change phase. Reconcile this session and wait for it to become idle.',
						},
					})
				const phase = reviewWorkEntry(input, locked.boundary?.task?.workflow_type ?? 'freeform', locked.session)

				const effectiveModel = model ?? session.model
				const effectiveEffort = effort !== undefined ? effort : session.effort
				const effectiveFastMode = fastMode !== undefined ? fastMode : session.fast_mode

				// Validate effort and fastMode against capability rules
				if (!isEffortSupported(session.coding_agent, session.provider, effectiveModel, effectiveEffort)) {
					throw errors.BAD_REQUEST({
						data: {
							message: `effort=${effectiveEffort} not supported for ${session.coding_agent}/${session.provider}/${effectiveModel}`,
						},
					})
				}
				if (!isFastModeSupported(session.coding_agent, session.provider, effectiveModel, effectiveFastMode)) {
					throw errors.BAD_REQUEST({
						data: {
							message: `fastMode not supported for ${session.coding_agent}/${session.provider}/${effectiveModel}`,
						},
					})
				}

				// Update session
				// Also unarchive the session when continuing (user interaction should unarchive)
				await tx
					.update(sessions)
					.set({
						...phase,
						status: 'resuming',
						error_message: null,
						error_reason: null,
						model: effectiveModel,
						effort: effectiveEffort ?? null,
						fast_mode: effectiveFastMode ?? false,
						permissions_mode: permissionsMode,
						archived: false,
						// provider and coding_agent remain unchanged from session creation
						last_activity_at: BigInt(nowMillis),
						num_events: sql`${sessions.num_events} + 1`,
						prompt: text,
					})
					.where(eq(sessions.id, sessionId))

				// Insert the user message as a conversation event
				const conversationEventValues: typeof conversationEvents.$inferInsert = {
					session_id: sessionId,
					organization_id: context.auth.organizationId,
					resource_owner_user_id: session.resource_owner_user_id,
					task_id: session.task_id,
					event_type: 'message',
					role: 'user',
					content: text,
					user_id: context.auth.userId,
				}
				if (eventId) conversationEventValues.id = eventId
				await tx.insert(conversationEvents).values(conversationEventValues)

				const txid = await getTxId(tx)
				await finishReviewWriter(tx, locked.boundary, started, {
					sessionId,
					eventId,
					entry: input,
					result: { transactionId: txid, success: true },
				})
				return { success: true, txid }
			})

			await tryEnsureSessionStreamHydrated(
				sessionId,
				db,
				{ organizationId: context.auth.organizationId, userId: context.auth.userId },
				'continue',
			)

			return {
				success: txResult.success,
				transactionId: txResult.txid,
			}
		} catch (error: unknown) {
			if (error instanceof ORPCError) {
				throw error
			}
			logger.error(error, 'Failed to continue session')
			throw errors.INTERNAL_SERVER_ERROR()
		}
	})

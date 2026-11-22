import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { decodeDelivery, deliveryReviewVerdict, sameDeliveryHeads } from '@humanlayer/schemas/zod/automatic-delivery'
import { and, asc, eq, exists, isNotNull, or, sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { claimTaskDelivery, completeTaskDelivery, deliveryContext, lockDeliveryTask } from '../../db/automatic-delivery'
import { reserveDeliveryBlockerAlerts } from '../../db/delivery-blocker-alerts'
import {
	completeImplementationInspection,
	readTaskReconciliation,
	reconcileImplementation,
} from '../../db/implementation-reconciliation'
import { enrollProjectDelivery } from '../../db/project-delivery'
import { TaskDiffService } from '../../effects/services/task-diff-durable-streams/task-diff-durable-streams.service'
import { dispatchDeliveryAlerts } from '../../lib/dispatch-delivery-alerts'
import { reconcileImplementationTask } from '../../lib/implementation-reconciliation-events'
import { daemonBase, requiresDaemonBillingMiddleware } from '../base'

export const claimDeliveryProcedure = daemonBase.delivery.claim
	.use(requiresDaemonBillingMiddleware)
	.handler(async ({ context }) => {
		const { organizationId, userId, hostId } = context.auth
		const { db, effectRuntime } = context.services
		const { action, alerts } = await db.transaction(async (tx) => {
			const candidates = await tx
				.select()
				.from(tasks)
				.where(
					and(
						eq(tasks.organization_id, organizationId),
						eq(tasks.resource_owner_user_id, userId),
						eq(tasks.archived, false),
						or(isNotNull(tasks.automatic_delivery), isNotNull(tasks.delivery_snapshot)),
					),
				)
				.for('no key update', { skipLocked: true })
			// Rotate waiting/manual-merge tasks behind less recently serviced tasks.
			candidates.sort(
				(a, b) =>
					(decodeDelivery(a.automatic_delivery)?.managedAt ?? 0) -
					(decodeDelivery(b.automatic_delivery)?.managedAt ?? 0),
			)
			for (const task of candidates) {
				await enrollProjectDelivery(tx, task, hostId)
				if (decodeDelivery(task.automatic_delivery)?.hostId !== hostId) continue
				const action = await claimTaskDelivery(tx, task)
				if (action) return { action, alerts: [] }
				const updated = await lockDeliveryTask(tx, task.id, organizationId)
				if (!updated) continue
				const alerts = await reserveDeliveryBlockerAlerts(tx, updated)
				if (alerts.length) return { action: null, alerts }
			}
			const legacy = await tx
				.select()
				.from(tasks)
				.where(
					and(
						eq(tasks.organization_id, organizationId),
						eq(tasks.resource_owner_user_id, userId),
						eq(tasks.archived, false),
						eq(tasks.is_draft, false),
						sql`${tasks.implementation_reconciliation} -> 'decision' ->> 'status' = 'verifying'`,
						sql`${tasks.implementation_reconciliation} -> 'decision' ->> 'hostId' = ${hostId}`,
						sql`(${tasks.implementation_reconciliation} -> 'lease' is null or
						(${tasks.implementation_reconciliation} -> 'lease' ->> 'expiresAt')::bigint <= ${Date.now()})`,
						exists(
							tx
								.select({ id: sessions.id })
								.from(sessions)
								.where(
									and(
										eq(sessions.task_id, tasks.id),
										eq(sessions.organization_id, organizationId),
										eq(sessions.resource_owner_user_id, userId),
										eq(sessions.host_id, hostId),
										eq(sessions.archived, false),
									),
								),
						),
					),
				)
				.orderBy(asc(tasks.id))
				.limit(24)
				.for('no key update', { skipLocked: true })
			for (const task of legacy) {
				const action = await reconcileImplementation(tx, task, { hostId })
				const alerts = await reserveDeliveryBlockerAlerts(tx, task)
				if (action || alerts.length) return { action, alerts }
			}
			return { action: null, alerts: [] }
		})
		await dispatchDeliveryAlerts(db, effectRuntime, alerts)
		return { action }
	})

export const completeDeliveryProcedure = daemonBase.delivery.complete
	.use(requiresDaemonBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		const { organizationId, userId, hostId } = context.auth
		const result = await context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, organizationId)
			if (!task) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== userId) throw errors.FORBIDDEN()
			const reconciliation = readTaskReconciliation(task)
			if (reconciliation.lease?.id === input.leaseId) {
				if (reconciliation.lease.hostId !== hostId) throw errors.FORBIDDEN()
				const accepted = await completeImplementationInspection(tx, task, { ...input, hostId })
				const recoverPublication =
					accepted && input.inspectionIssue === 'pr-missing' && task.auto_advance_implementation_to_pr
				return {
					accepted,
					archived: false,
					alerts: recoverPublication ? [] : await reserveDeliveryBlockerAlerts(tx, task),
					recoverPublication,
				}
			}
			const delivery = decodeDelivery(task.automatic_delivery)
			if (!delivery) return { accepted: false, archived: false, alerts: [] }
			if (delivery.hostId !== hostId) throw errors.FORBIDDEN()
			const accepted = await completeTaskDelivery(tx, task, input.leaseId, input.heads, input.error)
			const [updated] = await tx.select({ archived: tasks.archived }).from(tasks).where(eq(tasks.id, task.id))
			return { accepted, archived: updated?.archived === true, alerts: [] }
		})
		await dispatchDeliveryAlerts(context.services.db, context.services.effectRuntime, result.alerts)
		if (result.recoverPublication)
			await reconcileImplementationTask(context.services.db, context.services.effectRuntime, {
				taskId: input.taskId,
				organizationId,
			})
		if (result.archived)
			context.services.effectRuntime.runFork(
				Effect.gen(function* () {
					const taskDiff = yield* TaskDiffService
					yield* taskDiff.deleteTaskDiffStreams({ organizationId, taskId: input.taskId })
				}),
			)
		return { accepted: result.accepted }
	})
export const validateDeliveryProcedure = daemonBase.delivery.validate
	.use(requiresDaemonBillingMiddleware)
	.handler(async ({ input, context }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || task.resource_owner_user_id !== context.auth.userId)
				return { authorized: false }
			const delivery = decodeDelivery(task.automatic_delivery)
			if (
				!delivery ||
				delivery.authorizedBy !== task.resource_owner_user_id ||
				delivery.hostId !== context.auth.hostId ||
				delivery.mode !== 'merge' ||
				delivery.phase !== 'merge' ||
				delivery.lease?.id !== input.leaseId ||
				delivery.lease.expiresAt < Date.now()
			)
				return { authorized: false }
			const snapshot = await deliveryContext(tx, task, delivery)
			const review = delivery.reviews.at(-1)
			return {
				authorized:
					snapshot.allIdle &&
					!snapshot.untracked &&
					snapshot.revision === delivery.lease.revision &&
					review !== undefined &&
					deliveryReviewVerdict(review) === 'clean' &&
					sameDeliveryHeads(review.heads, delivery.heads),
			}
		})
	})

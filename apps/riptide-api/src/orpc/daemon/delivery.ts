import { tasks } from '@humanlayer/db/tables/tasks'
import { decodeDelivery, deliveryReviewVerdict, sameDeliveryHeads } from '@humanlayer/schemas/zod/automatic-delivery'
import { and, eq, isNotNull, or } from 'drizzle-orm'
import { Effect, Option } from 'effect'

import { claimTaskDelivery, completeTaskDelivery, deliveryContext, lockDeliveryTask } from '../../db/automatic-delivery'
import {
	finishSlackBlockerDispatch,
	reserveDeliveryBlockerAlerts,
	validateSlackBlockerDispatch,
} from '../../db/delivery-blocker-alerts'
import { enrollProjectDelivery } from '../../db/project-delivery'
import { SlackService } from '../../effects/services/slack/slack.service'
import { TaskDiffService } from '../../effects/services/task-diff-durable-streams/task-diff-durable-streams.service'
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
				const current = decodeDelivery(updated?.automatic_delivery)
				if (!updated || !current) continue
				const alerts = await reserveDeliveryBlockerAlerts(tx, updated, current)
				if (alerts.length) return { action: null, alerts }
			}
			return { action: null, alerts: [] }
		})
		for (const dispatch of alerts) {
			const slots = await db.transaction((tx) => validateSlackBlockerDispatch(tx, dispatch))
			const unavailable = dispatch.slots.filter((slot) => !slots.includes(slot))
			if (unavailable.length) {
				await db.transaction((tx) =>
					finishSlackBlockerDispatch(
						tx,
						{ ...dispatch, slots: unavailable },
						{ kind: 'preflight', canceled: slots.length === 0 },
					),
				)
			}
			if (!slots.length) continue
			const receipt = await effectRuntime.runPromise(
				Effect.gen(function* () {
					const slack = yield* SlackService
					return yield* slack.sendDeliveryBlocker(dispatch)
				}).pipe(
					Effect.timeoutOption('5 seconds'),
					Effect.map((result) => Option.getOrElse(result, () => ({ status: 'unknown' as const }))),
					Effect.catchCause(() => Effect.succeed({ status: 'unknown' as const })),
				),
			)
			await db.transaction((tx) =>
				finishSlackBlockerDispatch(tx, { ...dispatch, slots }, { kind: 'provider', result: receipt }),
			)
		}
		return { action }
	})

export const completeDeliveryProcedure = daemonBase.delivery.complete
	.use(requiresDaemonBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		const { organizationId, userId, hostId } = context.auth
		const result = await context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, organizationId)
			if (!task) throw errors.NOT_FOUND()
			const delivery = decodeDelivery(task.automatic_delivery)
			if (task.resource_owner_user_id !== userId || delivery?.hostId !== hostId) throw errors.FORBIDDEN()
			const accepted = await completeTaskDelivery(tx, task, input.leaseId, input.heads, input.error)
			const [updated] = await tx.select({ archived: tasks.archived }).from(tasks).where(eq(tasks.id, task.id))
			return { accepted, archived: updated?.archived === true }
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

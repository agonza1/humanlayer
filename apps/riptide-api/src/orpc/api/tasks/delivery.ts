import { tasks } from '@humanlayer/db/tables/tasks'
import { decodeDelivery, type AutomaticDelivery } from '@humanlayer/schemas/zod/automatic-delivery'
import { eq } from 'drizzle-orm'

import { acceptDeliveryReview, deliveryContext, lockDeliveryTask, saveDelivery } from '../../../db/automatic-delivery'
import {
	acknowledgeDeliveryBlocker,
	bindDeliveryAlertRoutes,
	rearmTaskAttentionRoutes,
	reserveDeliveryBlockerAlerts,
} from '../../../db/delivery-blocker-alerts'
import { readTaskReconciliation, saveTaskReconciliation } from '../../../db/implementation-reconciliation'
import { checkTaskWritePermission } from '../../../db/task-auth'
import { dispatchDeliveryAlerts } from '../../../lib/dispatch-delivery-alerts'
import { apiBaseOrgRequired, requiresBillingMiddleware } from '../../base'

export const configureDeliveryProcedure = apiBaseOrgRequired.tasks.delivery.configure
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			const existing = decodeDelivery(task.automatic_delivery)
			if (input.mode === 'disabled' && !existing && task.delivery_snapshot) {
				await tx
					.update(tasks)
					.set({
						delivery_snapshot: { mode: 'off', authorizedBy: context.auth.userId, authorizedAt: Date.now() },
					})
					.where(eq(tasks.id, task.id))
				return { delivery: null }
			}
			if (existing) {
				// Revocation is always allowed. Reconfiguration must never reset evidence or the pass budget.
				if (input.mode !== 'disabled')
					throw errors.CONFLICT({
						message: 'Delivery is already configured; its review budget cannot be reset',
					})
				existing.phase = 'disabled'
				existing.lease = null
				await saveDelivery(tx, task, existing)
				return { delivery: existing }
			}
			if (task.archived || task.is_draft || input.mode === 'disabled') throw errors.CONFLICT()
			const delivery: AutomaticDelivery = {
				version: 1,
				authorizedBy: context.auth.userId,
				authorizedAt: Date.now(),
				mode: input.mode,
				hostId: '',
				sourceSessionId: input.sourceSessionId,
				targets: input.targets,
				policyAcknowledgement: input.policyAcknowledgement,
				phase: 'implementation',
				passes: 0,
				recoveryAttempts: 0,
				managedSessionId: null,
				managedAt: 0,
				deliverySessionIds: [],
				workRevision: '',
				heads: [],
				reviews: [],
				attention: null,
				lease: null,
			}
			const snapshot = await deliveryContext(tx, task, delivery)
			const source = snapshot.history.find((session) => session.id === input.sourceSessionId)
			if (!source || source.archived || source.created_by !== context.auth.userId) throw errors.FORBIDDEN()
			delivery.hostId = source.host_id
			if (
				new Set(input.targets.map((target) => `${target.repository.toLowerCase()}:${target.branch}`)).size !==
				input.targets.length
			)
				throw errors.CONFLICT({ message: 'Delivery targets must be unique' })
			if (input.targets.some((target) => target.branch === target.base))
				throw errors.CONFLICT({ message: 'Delivery cannot target the base branch' })
			// Independent review checks task/repository merge policy before delivery.
			// Do not confuse worker-only no-merge instructions with a task-level veto.
			await tx
				.update(tasks)
				.set({ automatic_delivery: delivery, auto_advance_implementation_to_pr: false })
				.where(eq(tasks.id, task.id))
			return { delivery }
		})
	})

export const getDeliveryProcedure = apiBaseOrgRequired.tasks.delivery.get.handler(
	async ({ input, context, errors }) => {
		const check = await checkTaskWritePermission(
			context.services.db,
			input.taskId,
			context.auth.userId,
			context.auth.organizationId,
		)
		if (!check.ok) throw errors.NOT_FOUND()
		const [task] = await context.services.db
			.select({ delivery: tasks.automatic_delivery })
			.from(tasks)
			.where(eq(tasks.id, input.taskId))
		return { delivery: decodeDelivery(task?.delivery) }
	},
)

export const reportDeliveryReviewProcedure = apiBaseOrgRequired.tasks.delivery.reportReview
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			return { accepted: await acceptDeliveryReview(tx, task, input.review) }
		})
	})

export const configureDeliveryAlertsProcedure = apiBaseOrgRequired.tasks.delivery.configureAlerts
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		const { db, effectRuntime } = context.services
		const result = await db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || task.is_draft) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			const delivery = decodeDelivery(task.automatic_delivery)
			const routes = await bindDeliveryAlertRoutes(tx, task, delivery?.deliverySessionIds ?? [], input.routes)
			if (!routes)
				throw errors.FORBIDDEN({
					message: 'No requested alert route is authorized and available for this task.',
				})
			const reconciliation = readTaskReconciliation(task)
			if (input.routes.slackMode && !input.routes.origin)
				routes.origin = (reconciliation.alertRoutes ?? delivery?.alertRoutes)?.origin
			await rearmTaskAttentionRoutes(tx, task, {
				slack: input.routes.slackAutomationId ? routes.slack : undefined,
				origin: input.routes.origin ? routes.origin : undefined,
			})
			for (const state of [delivery, reconciliation]) {
				if (!state) continue
				state.alertRoutes = routes
				const alert = state.blockerAlert
				if (alert) {
					// Explicitly rebound routes can retry unavailable receipts while preserving settled or in-flight sends.
					if (routes.slack && alert.slack.status === 'unavailable') alert.slack = { status: 'pending' }
					if (routes.origin && alert.origin.status === 'unavailable') alert.origin = { status: 'pending' }
				}
			}
			if (delivery) {
				await saveDelivery(tx, task, delivery)
				task.automatic_delivery = delivery
			}
			await saveTaskReconciliation(tx, task, reconciliation)
			const alerts = await reserveDeliveryBlockerAlerts(tx, task)
			return { delivery, reconciliation: task.implementation_reconciliation, alerts }
		})
		await dispatchDeliveryAlerts(db, effectRuntime, result.alerts)
		return { delivery: result.delivery, reconciliation: result.reconciliation }
	})

export const acknowledgeDeliveryBlockerProcedure = apiBaseOrgRequired.tasks.delivery.acknowledgeBlocker
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || task.is_draft) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			return { acknowledged: await acknowledgeDeliveryBlocker(tx, task, input.alertId) }
		})
	})

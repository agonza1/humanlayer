import type { TaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { uuidv7 } from 'uuidv7'

import { lockDeliveryTask } from '../../../db/automatic-delivery'
import { activeTaskAttention, saveTaskAttention } from '../../../db/task-attention'
import { apiBaseOrgRequired, requiresBillingMiddleware } from '../../base'

function matches(attention: TaskAttention | null, expected: { id: string; revision: number } | null) {
	return (attention?.id ?? null) === (expected?.id ?? null) && attention?.revision === expected?.revision
}

export const setTaskAttentionProcedure = apiBaseOrgRequired.tasks.attention.set
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || (task.is_draft && !task.project_id)) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			const previous = activeTaskAttention(task)
			if (!matches(previous, input.expected)) throw errors.CONFLICT()
			const now = Date.now()
			const sameOccurrence = previous?.kind === input.attention.kind ? previous : null
			const sameFollowUp = sameOccurrence?.followUpAt === input.attention.followUpAt
			const attention: TaskAttention = {
				...input.attention,
				id: sameOccurrence?.id ?? uuidv7(),
				authorizedBy: context.auth.userId,
				revision: (sameOccurrence?.revision ?? 0) + 1,
				openedAt: sameOccurrence?.openedAt ?? now,
				updatedAt: now,
				acknowledgedAt: sameFollowUp ? sameOccurrence?.acknowledgedAt : undefined,
				notice: sameFollowUp ? sameOccurrence?.notice : undefined,
			}
			await saveTaskAttention(tx, task, attention, true)
			return { attention }
		})
	})

export const acknowledgeTaskAttentionProcedure = apiBaseOrgRequired.tasks.attention.acknowledge
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || (task.is_draft && !task.project_id)) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			const attention = activeTaskAttention(task)
			if (!attention || !matches(attention, input)) throw errors.CONFLICT()
			if (attention.acknowledgedAt === undefined) {
				attention.updatedAt = attention.acknowledgedAt = Date.now()
				attention.revision += 1
				await saveTaskAttention(tx, task, attention, true)
			}
			return { attention }
		})
	})

export const clearTaskAttentionProcedure = apiBaseOrgRequired.tasks.attention.clear
	.use(requiresBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		return context.services.db.transaction(async (tx) => {
			const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
			if (!task || task.archived || (task.is_draft && !task.project_id)) throw errors.NOT_FOUND()
			if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
			const attention = activeTaskAttention(task)
			if (!attention || !matches(attention, input)) throw errors.CONFLICT()
			attention.updatedAt = attention.resolvedAt = Date.now()
			attention.revision += 1
			await saveTaskAttention(tx, task, attention, true)
			return { attention }
		})
	})

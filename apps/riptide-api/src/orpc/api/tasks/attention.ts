import type { TaskAttention } from '@humanlayer/schemas/zod/task-attention'

import { authorTaskAttention } from '../../../db/author-task-attention'
import { lockDeliveryTask, type DeliveryTransaction } from '../../../db/automatic-delivery'
import { activeTaskAttention, saveTaskAttention } from '../../../db/task-attention'
import { apiBaseOrgRequired, requiresBillingMiddleware, type ApiContext } from '../../base'

type Cursor = Pick<TaskAttention, 'id' | 'revision'>
type Mutation = {
	input: { taskId: string }
	context: { services: ApiContext['services']; auth: { organizationId: string; userId: string } }
	errors: { NOT_FOUND(): Error; FORBIDDEN(): Error; CONFLICT(): Error }
}

function changeAttention(
	{ input, context, errors }: Mutation,
	expected: Cursor | null,
	change: (previous: TaskAttention | null) => TaskAttention,
) {
	return context.services.db.transaction(async (tx: DeliveryTransaction) => {
		const task = await lockDeliveryTask(tx, input.taskId, context.auth.organizationId)
		if (!task || task.archived || (task.is_draft && !task.project_id)) throw errors.NOT_FOUND()
		if (task.resource_owner_user_id !== context.auth.userId) throw errors.FORBIDDEN()
		const previous = activeTaskAttention(task)
		if (previous?.id !== expected?.id || previous?.revision !== expected?.revision) throw errors.CONFLICT()
		const attention = change(previous)
		if (attention !== previous) await saveTaskAttention(tx, task, attention, true)
		return { attention }
	})
}

function markAttention(args: Mutation & { input: Cursor }, field: 'acknowledgedAt' | 'resolvedAt') {
	return changeAttention(args, args.input, (previous) => {
		if (!previous) throw args.errors.CONFLICT()
		if (previous[field] !== undefined) return previous
		const now = Date.now()
		return { ...previous, revision: previous.revision + 1, updatedAt: now, [field]: now }
	})
}

const mutations = apiBaseOrgRequired.tasks.attention
export const setTaskAttentionProcedure = mutations.set
	.use(requiresBillingMiddleware)
	.handler((args) =>
		changeAttention(args, args.input.expected, (previous) =>
			authorTaskAttention(args.input.attention, args.context.auth.userId, previous),
		),
	)
export const acknowledgeTaskAttentionProcedure = mutations.acknowledge
	.use(requiresBillingMiddleware)
	.handler((args) => markAttention(args, 'acknowledgedAt'))
export const clearTaskAttentionProcedure = mutations.clear
	.use(requiresBillingMiddleware)
	.handler((args) => markAttention(args, 'resolvedAt'))

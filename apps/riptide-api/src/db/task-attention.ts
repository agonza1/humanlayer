import { projects } from '@humanlayer/db/tables/projects'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import type { SessionStatus } from '@humanlayer/schemas/zod/session/session-status'
import { decodeTaskAttention, type TaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { and, desc, eq, exists, inArray, isNull, ne, notExists, or, sql } from 'drizzle-orm'

import { standingSlackAttentionScope } from '../lib/local-slack-alert-relay'
import type { DeliveryTransaction } from './automatic-delivery'

type Task = typeof tasks.$inferSelect

const ACTIVE_WRITER_STATES = [
	'ready_for_launch',
	'waiting_for_workspace',
	'launching',
	'running',
	'resuming',
	'interrupt_requested',
] as const satisfies readonly SessionStatus[]

export function activeTaskAttention(task: Task) {
	if (task.archived || (task.is_draft && !task.project_id)) return null
	const attention = decodeTaskAttention(task.task_attention)
	return attention?.authorizedBy === task.resource_owner_user_id && attention.resolvedAt === undefined
		? attention
		: null
}

export async function saveTaskAttention(
	tx: DeliveryTransaction,
	task: Task,
	attention: TaskAttention,
	activity = false,
) {
	await tx
		.update(tasks)
		.set({ task_attention: attention, updated_at: activity ? BigInt(attention.updatedAt) : task.updated_at })
		.where(and(eq(tasks.id, task.id), eq(tasks.organization_id, task.organization_id)))
}

/** Use the task's managed host or latest owner session host. Hostless tasks can use an owner heartbeat. */
function idleTaskAttentionOnHost(tx: DeliveryTransaction, hostId: string) {
	const attachedSession = and(
		eq(sessions.task_id, tasks.id),
		eq(sessions.organization_id, tasks.organization_id),
		eq(sessions.archived, false),
	)
	const ownerHost = tx
		.select({ host: sessions.host_id })
		.from(sessions)
		.where(
			and(
				attachedSession,
				ne(sessions.status, 'draft'),
				eq(sessions.resource_owner_user_id, tasks.resource_owner_user_id),
			),
		)
		.orderBy(desc(sessions.last_activity_at), desc(sessions.id))
		.limit(1)
	const activeWriter = tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(attachedSession, inArray(sessions.status, ACTIVE_WRITER_STATES)))
	const pending = tx
		.select({ id: queuedMessages.id })
		.from(queuedMessages)
		.where(
			and(
				eq(queuedMessages.task_id, tasks.id),
				eq(queuedMessages.organization_id, tasks.organization_id),
				eq(queuedMessages.status, 'pending'),
			),
		)
	return and(
		sql`coalesce(
			case when ${tasks.automatic_delivery} ->> 'authorizedBy' = ${tasks.resource_owner_user_id}
				then nullif(${tasks.automatic_delivery} ->> 'hostId', '') end,
			(${ownerHost}),
			${hostId}
		) = ${hostId}`,
		notExists(activeWriter),
		notExists(pending),
	)
}

export async function isTaskAttentionIdleOnHost(tx: DeliveryTransaction, task: Task, hostId: string) {
	const [idle] = await tx
		.select({ id: tasks.id })
		.from(tasks)
		.where(
			and(
				eq(tasks.id, task.id),
				eq(tasks.organization_id, task.organization_id),
				idleTaskAttentionOnHost(tx, hostId),
			),
		)
	return idle !== undefined
}

export async function lockDueTaskAttention(
	tx: DeliveryTransaction,
	scope: { organizationId: string; userId: string; hostId: string },
	now: number,
) {
	const state = tasks.task_attention
	const standing = standingSlackAttentionScope({ organizationId: scope.organizationId, ownerId: scope.userId })
	const routes = sql`coalesce(${tasks.implementation_reconciliation} -> 'alertRoutes', ${tasks.automatic_delivery} -> 'alertRoutes')`
	const standingProjects =
		standing &&
		tx
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.id, tasks.project_id),
					eq(projects.organization_id, scope.organizationId),
					eq(projects.resource_owner_user_id, scope.userId),
					eq(projects.archived, false),
					isNull(projects.team_id),
					inArray(projects.id, standing.projectIds),
				),
			)
	const [task] = await tx
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.organization_id, scope.organizationId),
				eq(tasks.resource_owner_user_id, scope.userId),
				eq(tasks.archived, false),
				sql`(${tasks.is_draft} = false or ${tasks.project_id} is not null)`,
				sql`${state} ->> 'authorizedBy' = ${scope.userId}`,
				sql`${state} ->> 'resolvedAt' is null`,
				sql`${state} ->> 'acknowledgedAt' is null`,
				or(
					sql`${state} ->> 'notice' is null`,
					sql`${state} #>> '{notice,slack,status}' = 'pending'`,
					sql`${state} #>> '{notice,origin,status}' = 'pending'`,
					standing && standingProjects
						? and(
								eq(tasks.slack_notifications_muted, false),
								exists(standingProjects),
								sql`(${routes} is null or (${routes} -> 'slack' is null and ${routes} ->> 'slackMode' = 'inherit'))`,
								sql`${state} #>> '{notice,slack,status}' in ('failed', 'unavailable')`,
								sql`${state} #>> '{notice,standingSlackAttempt}' is distinct from ${standing.revision}`,
							)
						: undefined,
				),
				sql`(${state} ->> 'kind' = 'owner_input' or (
				${state} ->> 'kind' = 'external_wait' and (${state} ->> 'followUpAt')::bigint <= ${now}
			))`,
				idleTaskAttentionOnHost(tx, scope.hostId),
			),
		)
		.orderBy(sql`coalesce((${state} ->> 'followUpAt')::bigint, (${state} ->> 'openedAt')::bigint)`, tasks.id)
		.limit(1)
		.for('no key update', { skipLocked: true })
	return task
}

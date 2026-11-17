import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { decodeDelivery } from '@humanlayer/schemas/zod/automatic-delivery'
import { ORPCError } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'

type Tx = PgDatabase<PostgresJsQueryResultHKT>

/** Session writers take the same task lock as delivery before changing task work. */
export async function guardTaskDeliveryMutation(tx: Tx, taskId: string | null | undefined, organizationId: string) {
	if (!taskId) return
	const [task] = await tx
		.select({ delivery: tasks.automatic_delivery })
		.from(tasks)
		.where(and(eq(tasks.id, taskId), eq(tasks.organization_id, organizationId)))
		.for('no key update')
	const delivery = decodeDelivery(task?.delivery)
	if (
		delivery &&
		!['disabled', 'attention', 'archived'].includes(delivery.phase) &&
		(delivery.managedSessionId !== null || delivery.lease !== null)
	) {
		throw new ORPCError('BAD_REQUEST', {
			message:
				'Could not start more work. Automatic delivery is in progress. Disable delivery before changing this task.',
		})
	}
}

export async function guardSessionDeliveryMutation(tx: Tx, sessionId: string, organizationId: string) {
	const [session] = await tx
		.select({ taskId: sessions.task_id })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.organization_id, organizationId)))
	await guardTaskDeliveryMutation(tx, session?.taskId, organizationId)
}

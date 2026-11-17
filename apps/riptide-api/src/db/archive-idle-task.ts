import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'

/** Shared archive mutation; callers authorize and lock/revalidate eligibility before calling. */
export async function archiveTaskRows(
	tx: PgDatabase<PostgresJsQueryResultHKT>,
	taskId: string,
	organizationId: string,
	archived: boolean,
	cascadeToSessions: boolean,
) {
	await tx
		.update(tasks)
		.set({ archived })
		.where(and(eq(tasks.id, taskId), eq(tasks.organization_id, organizationId)))
	if (!cascadeToSessions) return 0
	const result = await tx
		.update(sessions)
		.set({ archived })
		.where(and(eq(sessions.task_id, taskId), eq(sessions.organization_id, organizationId)))
		.returning({ id: sessions.id })
	return result.length
}

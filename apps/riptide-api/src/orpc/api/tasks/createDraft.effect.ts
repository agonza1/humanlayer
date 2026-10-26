import { projects } from '@humanlayer/db/tables/projects'
import { taskOrganizationAcl } from '@humanlayer/db/tables/task-organization-acl'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, eq, isNull } from 'drizzle-orm'
import { Effect } from 'effect'

import { DEFAULT_TASK_SHARE_LEVEL, resolveOrgDefaultTaskShareLevel } from '../../../db/organization-settings'
import { projectReadableByActor } from '../../../effects/project-workspace/project-authorization'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { getTransactionId } from '../../../effects/services/postgres/helpers'
import { PostgresDb } from '../../../effects/services/postgres/postgres-db.service'
import { Sentry } from '../../../instrument'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

export const createTaskDraftEffectProcedure = effectOrpcBaseOrganizationRequired.tasks.createDraft.effect(function* ({
	input,
	context,
	errors,
}) {
	const postgres = yield* PostgresDb
	const {
		id,
		projectId,
		name,
		slug,
		defaultWorkingDirectory,
		ticketId,
		ticketDescription,
		ticketProvider,
		githubConnectionId,
		ticketRepositoryId,
		ticketRepositoryFullName,
	} = input
	const { userId, organizationId } = context.auth

	const result = yield* postgres
		.transaction((tx) =>
			Effect.gen(function* () {
				if (projectId) {
					const [project] = yield* tx.query(
						tx.client
							.select({ id: projects.id })
							.from(projects)
							.where(
								and(
									eq(projects.id, projectId),
									eq(projects.archived, false),
									projectReadableByActor({ organizationId, userId }),
								),
							)
							.limit(1)
							.for('share'),
					)
					if (!project) {
						return yield* Effect.fail(
							errors.NOT_FOUND({
								data: { message: 'Could not create draft. Choose an available project.' },
							}),
						)
					}
				}
				const draftValues: typeof tasks.$inferInsert = {
					project_id: projectId ?? null,
					name: name || 'Untitled Draft',
					slug: slug || null,
					default_working_directory: defaultWorkingDirectory || null,
					organization_id: organizationId,
					created_by: userId,
					resource_owner_user_id: userId,
					ticket_id: ticketId || null,
					ticket_description: ticketDescription || null,
					ticket_provider: ticketProvider || null,
					github_connection_id: githubConnectionId ?? null,
					ticket_repository_id: ticketRepositoryId ?? null,
					ticket_repository_full_name: ticketRepositoryFullName ?? null,
					is_draft: true,
				}
				if (id) draftValues.id = id

				const [insertedTask] = yield* tx.query(
					tx.client.insert(tasks).values(draftValues).onConflictDoNothing({ target: tasks.id }).returning(),
				)

				if (!insertedTask) {
					if (id) {
						const [existingDraft] = yield* tx.query(
							tx.client
								.select()
								.from(tasks)
								.where(
									and(
										eq(tasks.id, id),
										eq(tasks.organization_id, organizationId),
										eq(tasks.resource_owner_user_id, userId),
										eq(tasks.is_draft, true),
										eq(tasks.archived, false),
										projectId ? eq(tasks.project_id, projectId) : isNull(tasks.project_id),
									),
								)
								.limit(1)
								.for('share'),
						)
						if (existingDraft) return { task: existingDraft, txid: yield* getTransactionId(tx) }
						return yield* Effect.fail(errors.TASK_DRAFT_IDENTITY_CONFLICT())
					}
					return yield* Effect.fail(
						errors.INTERNAL_SERVER_ERROR({ data: { message: 'Unable to insert task draft' } }),
					)
				}

				// Resolve org default task share level
				const defaultTaskShareLevel = yield* tx.run(() =>
					resolveOrgDefaultTaskShareLevel(tx.client, organizationId),
				)

				yield* tx.query(
					tx.client.insert(taskOrganizationAcl).values({
						organization_id: organizationId,
						task_id: insertedTask.id,
						resource_owner_user_id: userId,
						permission_level: defaultTaskShareLevel ?? DEFAULT_TASK_SHARE_LEVEL,
						granted_by: userId,
					}),
				)

				const txid = yield* getTransactionId(tx)

				return { task: insertedTask, txid }
			}),
		)
		.pipe(
			Effect.tap(({ task }) =>
				Effect.logInfo('Task draft created').pipe(
					Effect.annotateLogs({ taskId: task.id, userId, organizationId }),
				),
			),
			Effect.tapError((e) => Effect.logError(e)),
			Effect.tapError((e) => Effect.sync(() => Sentry.captureException(e))),
			Effect.catchTags({
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)

	return { transactionId: result.txid, task: result.task }
})

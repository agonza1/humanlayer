import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import {
	workspaceRepositoryStatusForUserForHost,
	workspaceRepositoryStatusSelectSchema,
} from '@humanlayer/db/tables/workspace-repository-status-for-user-for-host'
import { workspaces, workspaceSelectSchema } from '@humanlayer/db/tables/workspaces'
import {
	TaskDeliverySnapshotSchema,
	type AutomaticDelivery,
	type DeliveryTarget,
} from '@humanlayer/schemas/zod/automatic-delivery'
import { and, desc, eq } from 'drizzle-orm'

import { saveDelivery, type DeliveryTransaction } from './automatic-delivery'

export async function enrollProjectDelivery(tx: DeliveryTransaction, task: typeof tasks.$inferSelect, hostId: string) {
	if (
		task.automatic_delivery !== null ||
		!task.delivery_snapshot ||
		!task.workspace_id ||
		!task.project_id ||
		task.archived ||
		task.is_draft
	)
		return
	const raw = task.delivery_snapshot
	const snapshot = TaskDeliverySnapshotSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
	if (snapshot.mode === 'off' || snapshot.authorizedBy !== task.resource_owner_user_id) return
	const history = await tx
		.select()
		.from(sessions)
		.where(and(eq(sessions.task_id, task.id), eq(sessions.organization_id, task.organization_id)))
		.orderBy(desc(sessions.created_at))
	const source = history.find((session) => {
		const labels = typeof session.labels === 'string' ? JSON.parse(session.labels) : session.labels
		return Array.isArray(labels) && labels.some((label) => label.name === 'rpi:implementation')
	})
	if (
		!source ||
		source.host_id !== hostId ||
		source.created_by !== snapshot.authorizedBy ||
		source.resource_owner_user_id !== snapshot.authorizedBy ||
		source.archived
	)
		return
	const [row] = await tx
		.select()
		.from(workspaces)
		.where(
			and(
				eq(workspaces.id, task.workspace_id),
				eq(workspaces.project_id, task.project_id),
				eq(workspaces.organization_id, task.organization_id),
			),
		)
	if (!row || row.resource_owner_user_id !== snapshot.authorizedBy || row.archived) return
	const workspace = workspaceSelectSchema.parse(row)
	const reports = await tx
		.select()
		.from(workspaceRepositoryStatusForUserForHost)
		.where(
			and(
				eq(workspaceRepositoryStatusForUserForHost.workspace_id, workspace.id),
				eq(workspaceRepositoryStatusForUserForHost.project_id, task.project_id),
				eq(workspaceRepositoryStatusForUserForHost.organization_id, task.organization_id),
				eq(workspaceRepositoryStatusForUserForHost.user_id, snapshot.authorizedBy),
				eq(workspaceRepositoryStatusForUserForHost.host_id, hostId),
			),
		)
	if (reports.length !== workspace.repositories.length) return
	const targets: DeliveryTarget[] = []
	for (const reportRow of reports) {
		const report = workspaceRepositoryStatusSelectSchema.parse(reportRow)
		const recipe = workspace.repositories.find((repo) => repo.repositoryIdentity === report.repository_identity)
		const materialized = report.materialization
		if (
			!recipe ||
			report.repository_remote_url !== recipe.remoteUrl ||
			report.status !== 'done' ||
			!report.repo_available ||
			report.error ||
			!materialized ||
			!materialized.path.startsWith('/') ||
			materialized.branch !== recipe.branch ||
			recipe.branch === recipe.defaultBranch ||
			!recipe.repositoryIdentity.startsWith('github.com/')
		)
			return
		targets.push({
			repository: recipe.repositoryIdentity.slice('github.com/'.length),
			branch: materialized.branch,
			base: recipe.defaultBranch,
			directory: materialized.path,
		})
	}
	const delivery: AutomaticDelivery = {
		version: 1,
		...snapshot,
		mode: snapshot.mode,
		hostId,
		sourceSessionId: source.id,
		targets,
		policyAcknowledgement:
			'Task-owner project delivery selection. Repository policy, explicit task limits and later human vetoes remain binding.',
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
	await saveDelivery(tx, task, delivery)
	task.automatic_delivery = delivery
}

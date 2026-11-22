import { createHash } from 'node:crypto'

import { commits } from '@humanlayer/db/tables/commits'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { projects, projectSelectSchema } from '@humanlayer/db/tables/projects'
import { pullRequests } from '@humanlayer/db/tables/pull-requests'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { workspaces, workspaceSelectSchema } from '@humanlayer/db/tables/workspaces'
import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import { getBoardColumn } from '@humanlayer/schemas/task-board'
import {
	decodeDelivery,
	deliveryReviewVerdict,
	DeliveryTargetSchema,
	sameDeliveryHeads,
	TaskDeliverySnapshotSchema,
	type DeliveryHead,
	type DeliveryInspectionIssue,
	type DeliveryTarget,
} from '@humanlayer/schemas/zod/automatic-delivery'
import {
	decodeImplementationReconciliation,
	type ImplementationBlocker,
	type ImplementationReconciliation,
} from '@humanlayer/schemas/zod/implementation-reconciliation'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import type { DeliveryTransaction } from './automatic-delivery'

type Task = typeof tasks.$inferSelect
type Session = typeof sessions.$inferSelect
type Repository = typeof sessionRepositories.$inferSelect
type Decision = ImplementationReconciliation['decision']
type Stage = 'implementation' | 'in-review'

const HOST_HEARTBEAT_LIMIT_MS = 120_000
const INSPECTION_LEASE_MS = 120_000
const MAX_INSPECTIONS = 2
const STOCK_HANDOFF_LIMIT_MS = 30 * 60_000
const STOPPED = new Set(['draft', 'ready_for_input', 'failed', 'interrupted', 'lost'])
const ACTIVE_DELIVERY = new Set(['implementation', 'pr', 'inspect', 'review', 'repair', 'merge', 'archive'])
const IMPLEMENTATION_LABELS = new Set(['rpi:implementation', 'rpi:describe-pr', 'rpi:review'])
const ISSUE_BLOCKERS = {
	checkout: 'checkout-changed',
	'pr-missing': 'pr-missing',
	'pr-ambiguous': 'pr-ambiguous',
	'pr-head-mismatch': 'head-mismatch',
	'remote-head-mismatch': 'head-mismatch',
} as const satisfies Record<DeliveryInspectionIssue, ImplementationBlocker>
const INSPECTION_BLOCKERS = new Set<ImplementationBlocker>([
	...Object.values(ISSUE_BLOCKERS),
	'pr-not-ready',
	'verification-failed',
	'verification-expired',
])

const block = (reason: ImplementationBlocker, stage: Stage = 'implementation'): Decision => ({
	status: 'blocked',
	reason,
	stage,
})

function sessionLabels(session: Pick<Session, 'labels'>): NonNullable<Session['labels']> {
	const labels = session.labels
	if (typeof labels === 'string') {
		try {
			const value: unknown = JSON.parse(labels)
			return Array.isArray(value) ? value : []
		} catch {
			return []
		}
	}
	return labels ?? []
}

export function hasLabel(session: Pick<Session, 'labels'>, name: string) {
	return sessionLabels(session).some((label) => label.name === name)
}

export function readTaskReconciliation(
	task: Pick<Task, 'implementation_reconciliation'>,
): ImplementationReconciliation {
	return decodeImplementationReconciliation(task.implementation_reconciliation) ?? { version: 1, decision: null }
}

export async function saveTaskReconciliation(
	tx: DeliveryTransaction,
	task: Task,
	current: ImplementationReconciliation,
) {
	if (JSON.stringify(readTaskReconciliation(task)) === JSON.stringify(current)) return
	// Workflow observation must not change the card's recorded user/worker activity time.
	await tx
		.update(tasks)
		.set({ implementation_reconciliation: current, updated_at: task.updated_at })
		.where(and(eq(tasks.id, task.id), eq(tasks.organization_id, task.organization_id)))
	task.implementation_reconciliation = current
}

async function setDecision(
	tx: DeliveryTransaction,
	task: Task,
	current: ImplementationReconciliation,
	decision: Decision,
	options?: Pick<ImplementationReconciliation, 'revision' | 'heads' | 'lease' | 'inspectionAttempts' | 'wakeAt'>,
) {
	const sameBlocker =
		current.decision?.status === 'blocked' &&
		decision?.status === 'blocked' &&
		current.decision.reason === decision.reason &&
		current.decision.stage === decision.stage
	await saveTaskReconciliation(tx, task, {
		version: 1,
		decision,
		alertRoutes: current.alertRoutes,
		blockerAlert: sameBlocker ? current.blockerAlert : undefined,
		...options,
	})
}

export async function readImplementationSessions(tx: DeliveryTransaction, task: Task) {
	return tx
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.task_id, task.id),
				eq(sessions.organization_id, task.organization_id),
				eq(sessions.archived, false),
			),
		)
		.orderBy(desc(sessions.created_at), desc(sessions.id))
		.for('no key update')
}

function implementationSource(history: Session[]) {
	const started = history.filter((row) => row.status !== 'draft')
	const column = getBoardColumn(
		started.map((row) => ({ ...row, labels: sessionLabels(row), last_activity_at: row.created_at })),
	)
	if (column !== 'implementation' && column !== 'in-review') return null
	return (
		started.find((row) => sessionLabels(row).some((label) => IMPLEMENTATION_LABELS.has(label.name))) ??
		started.find((row) => !sessionLabels(row).some((label) => label.name.startsWith('rpi:'))) ??
		null
	)
}

async function hasPendingWork(tx: DeliveryTransaction, task: Task) {
	const [message] = await tx
		.select({ id: queuedMessages.id })
		.from(queuedMessages)
		.where(
			and(
				eq(queuedMessages.task_id, task.id),
				eq(queuedMessages.organization_id, task.organization_id),
				eq(queuedMessages.status, 'pending'),
			),
		)
		.limit(1)
	return message !== undefined
}

async function hostDeadline(tx: DeliveryTransaction, task: Task, hostId: string, now: number) {
	const [host] = await tx
		.select({ status: onlineHosts.status, lastSeen: onlineHosts.last_seen })
		.from(onlineHosts)
		.where(
			and(
				eq(onlineHosts.organization_id, task.organization_id),
				eq(onlineHosts.user_id, task.resource_owner_user_id),
				eq(onlineHosts.host_id, hostId),
			),
		)
	const deadline = Number(host?.lastSeen) + HOST_HEARTBEAT_LIMIT_MS
	return host?.status === 'online' && deadline > now ? deadline : undefined
}

function targetKey(target: DeliveryTarget) {
	return JSON.stringify([target.repository.toLowerCase(), target.branch, target.base, target.directory])
}

async function readTargets(tx: DeliveryTransaction, task: Task, history: Session[], source: Session) {
	const known = await tx
		.select()
		.from(sessionRepositories)
		.where(
			and(
				eq(sessionRepositories.organization_id, task.organization_id),
				eq(sessionRepositories.task_id, task.id),
				eq(sessionRepositories.is_head, true),
			),
		)
	const workerIds = new Set(history.filter((row) => row.status !== 'draft').map((row) => row.id))
	const observed = known.filter((row) => workerIds.has(row.session_id))
	if (
		!task.project_id ||
		observed.some((row) => row.host_id !== source.host_id || !row.branch || !row.repo_full_name)
	)
		return null

	const [projectRow] = await tx
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.id, task.project_id),
				eq(projects.organization_id, task.organization_id),
				eq(projects.archived, false),
			),
		)
	const project = projectSelectSchema.safeParse(projectRow).data
	if (!project) return null

	const baseFor = (repo: Repository) =>
		project.repositories.find(
			(item) => item.repositoryIdentity.toLowerCase() === `github.com/${repo.repo_full_name}`,
		)?.defaultBranch

	const nonBase = observed.filter((row) => row.branch !== baseFor(row))
	const targets = new Map<string, DeliveryTarget>()
	for (const repo of nonBase) {
		const target = DeliveryTargetSchema.safeParse({
			repository: repo.repo_full_name,
			branch: repo.branch,
			base: baseFor(repo),
			directory: repo.local_path,
		}).data
		if (!target || !target.directory.startsWith('/')) return null
		const identity = target.repository.toLowerCase()
		const previous = targets.get(identity)
		if (previous && targetKey(previous) !== targetKey(target)) return null
		targets.set(identity, target)
	}

	if (task.workspace_id) {
		const [row] = await tx
			.select()
			.from(workspaces)
			.where(
				and(
					eq(workspaces.id, task.workspace_id),
					eq(workspaces.project_id, task.project_id),
					eq(workspaces.organization_id, task.organization_id),
					eq(workspaces.archived, false),
				),
			)
		const workspace = workspaceSelectSchema.safeParse(row).data
		if (
			!workspace ||
			workspace.resource_owner_user_id !== task.resource_owner_user_id ||
			workspace.repositories.length !== targets.size ||
			workspace.repositories.some((item) => {
				const target = targets.get(item.repositoryIdentity.toLowerCase().replace(/^github\.com\//, ''))
				return !target || target.branch !== item.branch || target.base !== item.defaultBranch
			})
		)
			return null
	}

	return targets.size > 0 && targets.size <= 10
		? [...targets.values()].sort((left, right) => targetKey(left).localeCompare(targetKey(right)))
		: null
}

async function inspectionRevision(tx: DeliveryTransaction, task: Task, history: Session[], targets: DeliveryTarget[]) {
	const links = await tx
		.select({
			repository: pullRequests.repo_full_name,
			number: pullRequests.number,
			branch: pullRequests.head_ref,
			sha: pullRequests.head_sha,
			state: pullRequests.state,
			draft: pullRequests.is_draft,
		})
		.from(pullRequests)
		.where(
			and(
				eq(pullRequests.organization_id, task.organization_id),
				or(
					eq(pullRequests.task_id, task.id),
					...targets.map((target) =>
						and(
							eq(pullRequests.repo_full_name, target.repository.toLowerCase()),
							eq(pullRequests.head_ref, target.branch),
						),
					),
				),
			),
		)
	const recentCommits = await tx
		.select({ sha: commits.commit_sha })
		.from(commits)
		.where(and(eq(commits.organization_id, task.organization_id), eq(commits.task_id, task.id)))
		.orderBy(desc(commits.created_at), desc(commits.id))
		.limit(10)
	const [lastImplementationMessage] = await tx
		.select({ id: conversationEvents.id })
		.from(conversationEvents)
		.where(
			and(
				eq(conversationEvents.organization_id, task.organization_id),
				eq(conversationEvents.task_id, task.id),
				inArray(
					conversationEvents.session_id,
					history.map((row) => row.id),
				),
				eq(conversationEvents.event_type, 'message'),
				eq(conversationEvents.role, 'assistant'),
			),
		)
		.orderBy(desc(conversationEvents.created_at), desc(conversationEvents.id))
		.limit(1)
	return createHash('sha256')
		.update(
			JSON.stringify([
				task.id,
				task.resource_owner_user_id,
				task.project_id,
				task.workspace_id,
				task.ticket_description,
				task.delivery_snapshot,
				task.auto_advance_implementation_to_pr,
				history
					.filter((row) => row.status !== 'draft')
					.map((row) => [
						row.id,
						row.status,
						row.host_id,
						row.working_directory,
						row.labels,
						row.prompt,
						row.coding_agent_session_id,
					]),
				targets,
				links.map((row) => JSON.stringify(row)).sort(),
				recentCommits,
				lastImplementationMessage?.id,
			]),
		)
		.digest('hex')
}

function canInspectAutomaticDelivery(task: Task) {
	const delivery = decodeDelivery(task.automatic_delivery)
	if (delivery) return delivery.phase === 'disabled'
	const raw = task.delivery_snapshot
	const snapshot = TaskDeliverySnapshotSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw).data
	return !snapshot || snapshot.mode === 'off'
}

export async function mayRecoverStockPublication(tx: DeliveryTransaction, task: Task, sessionId: string) {
	const current = readTaskReconciliation(task)
	if (current.decision?.status !== 'blocked' || current.decision.reason !== 'pr-missing') return false
	const history = await readImplementationSessions(tx, task)
	const source = implementationSource(history)
	if (!source || source.id !== sessionId || !(await hostDeadline(tx, task, source.host_id, Date.now()))) return false
	const targets = await readTargets(tx, task, history, source)
	return targets !== null && current.revision === (await inspectionRevision(tx, task, history, targets))
}

/** Run under the stock task lock. A legacy dispatch is read-only and carries no delivery enrollment. */
export async function reconcileImplementation(
	tx: DeliveryTransaction,
	task: Task,
	options: { hostId?: string; now?: number } = {},
): Promise<DeliveryAction | null> {
	if (task.archived || task.is_draft) return null
	const current = readTaskReconciliation(task)
	const history = await readImplementationSessions(tx, task)
	const source = implementationSource(history)
	const delivery = decodeDelivery(task.automatic_delivery)
	const now = options.now ?? Date.now()
	const managed = delivery && ACTIVE_DELIVERY.has(delivery.phase)
	const inReview = delivery && ['review', 'inspect', 'merge', 'archive'].includes(delivery.phase)
	const stage =
		(inReview && delivery.heads.length) || (!managed && current.heads?.length) ? 'in-review' : 'implementation'
	if (!source || delivery?.phase === 'attention' || delivery?.phase === 'archived') {
		await setDecision(tx, task, current, null)
		return null
	}
	if (managed && delivery.authorizedBy !== task.resource_owner_user_id) {
		await setDecision(tx, task, current, block('enrollment-unavailable', stage))
		return null
	}
	const latest = history.find((row) => row.status !== 'draft')
	const hostId = delivery?.hostId || source.host_id
	const busy = history.find((row) => !STOPPED.has(row.status))
	const expiresAt = await hostDeadline(tx, task, busy?.host_id ?? hostId, now)
	const online = expiresAt !== undefined

	if (busy || (await hasPendingWork(tx, task))) {
		let decision: Decision = null
		let wakeAt = expiresAt
		if (!online) {
			const uncertainWriter =
				busy && ['running', 'launching', 'resuming', 'interrupt_requested'].includes(busy.status)
			decision = block(uncertainWriter ? 'writer-unknown' : 'host-unavailable', stage)
		} else if (delivery?.phase !== 'pr' && busy?.status === 'needs_approval') {
			decision = block('approval-required', stage)
		} else if (delivery?.phase !== 'pr' && busy?.status === 'waiting_for_usage_limit') {
			decision = block('usage-limit', stage)
		} else if (
			!managed &&
			busy &&
			hasLabel(busy, 'rpi:describe-pr') &&
			['ready_for_launch', 'waiting_for_workspace'].includes(busy.status)
		) {
			const deadlineAt = Number(busy.created_at) + STOCK_HANDOFF_LIMIT_MS
			if (deadlineAt <= now) {
				decision = block('publication-unavailable')
				wakeAt = undefined
			} else {
				decision = { status: 'waiting-publication', sessionId: busy.id, deadlineAt }
				wakeAt = Math.min(expiresAt, deadlineAt)
			}
		}
		await setDecision(tx, task, current, decision, { wakeAt })
		return null
	}

	if (managed || !canInspectAutomaticDelivery(task)) {
		await setDecision(
			tx,
			task,
			current,
			online ? (!managed ? block('enrollment-unavailable', stage) : null) : block('host-unavailable', stage),
			{ wakeAt: managed ? expiresAt : undefined },
		)
		return null
	}

	if (
		source.resource_owner_user_id !== task.resource_owner_user_id ||
		source.created_by !== task.resource_owner_user_id
	) {
		await setDecision(tx, task, current, block('owner-required'))
		return null
	}
	if (history.some((row) => row.status === 'lost')) {
		await setDecision(tx, task, current, block('writer-unknown'))
		return null
	}
	if (latest && ['failed', 'interrupted'].includes(latest.status)) {
		await setDecision(
			tx,
			task,
			current,
			block(hasLabel(latest, 'rpi:describe-pr') ? 'publication-unavailable' : 'session-stopped'),
		)
		return null
	}

	const targets = await readTargets(tx, task, history, source)
	if (!targets) {
		await setDecision(tx, task, current, block(online ? 'workspace-required' : 'host-unavailable'))
		return null
	}
	const revision = await inspectionRevision(tx, task, history, targets)
	const matching = current.revision === revision
	if (matching && current.heads?.length) return null
	if (!online) {
		await setDecision(tx, task, current, block('host-unavailable'), { revision })
		return null
	}
	if (matching && current.decision?.status === 'blocked' && INSPECTION_BLOCKERS.has(current.decision.reason))
		return null

	let deadlineAt =
		matching && current.decision?.status === 'verifying' ? current.decision.deadlineAt : now + INSPECTION_LEASE_MS
	let lease = matching ? current.lease : undefined
	const inspectionAttempts = matching ? (current.inspectionAttempts ?? 0) : 0
	if (deadlineAt <= now) {
		if (!lease || inspectionAttempts >= MAX_INSPECTIONS) {
			await setDecision(tx, task, current, block('verification-expired'), { revision, inspectionAttempts })
			return null
		}
		// A legacy inspect can only read Git/PR state. A lost reply allows one bounded re-issue.
		deadlineAt = now + INSPECTION_LEASE_MS
		lease = undefined
	}
	const decision = { status: 'verifying', deadlineAt, hostId: source.host_id } as const
	const wakeAt = Math.min(expiresAt, deadlineAt)
	if (options.hostId !== source.host_id || lease) {
		await setDecision(tx, task, current, decision, { revision, lease, inspectionAttempts, wakeAt })
		return null
	}

	const claim = { id: uuidv7(), hostId: source.host_id, expiresAt: deadlineAt }
	await setDecision(tx, task, current, decision, {
		revision,
		lease: claim,
		inspectionAttempts: inspectionAttempts + 1,
		wakeAt,
	})
	return { taskId: task.id, leaseId: claim.id, kind: 'inspect', targets, heads: [] }
}

export async function completeImplementationInspection(
	tx: DeliveryTransaction,
	task: Task,
	input: {
		leaseId: string
		hostId: string
		heads: DeliveryHead[]
		error: string | null
		inspectionIssue?: DeliveryInspectionIssue
		now?: number
	},
) {
	const current = readTaskReconciliation(task)
	if (
		task.archived ||
		task.is_draft ||
		!canInspectAutomaticDelivery(task) ||
		current.lease?.id !== input.leaseId ||
		current.lease.hostId !== input.hostId
	)
		return false
	const history = await readImplementationSessions(tx, task)
	const source = implementationSource(history)
	if (
		!source ||
		source.host_id !== input.hostId ||
		source.created_by !== task.resource_owner_user_id ||
		history.some((row) => !STOPPED.has(row.status)) ||
		(await hasPendingWork(tx, task))
	) {
		await setDecision(tx, task, current, null)
		return false
	}
	const targets = await readTargets(tx, task, history, source)
	if (!targets || current.revision !== (await inspectionRevision(tx, task, history, targets))) {
		await setDecision(tx, task, current, null)
		return false
	}
	const revision = current.revision
	if (current.lease.expiresAt <= (input.now ?? Date.now())) return false

	if (
		input.error ||
		targets.length !== input.heads.length ||
		targets.some((target) => !input.heads.some((head) => targetKey(head) === targetKey(target)))
	) {
		const issue = input.inspectionIssue && ISSUE_BLOCKERS[input.inspectionIssue]
		await setDecision(tx, task, current, block(issue ?? 'verification-failed'), { revision })
		return true
	}
	if (input.heads.some((head) => head.draft !== false && !head.merged)) {
		await setDecision(tx, task, current, block('pr-not-ready'), { revision })
		return true
	}
	const review = decodeDelivery(task.automatic_delivery)?.reviews.at(-1)
	const reviewed = review && sameDeliveryHeads(review.heads, input.heads) && deliveryReviewVerdict(review) === 'clean'
	await setDecision(tx, task, current, reviewed ? { status: 'review' } : block('review-required', 'in-review'), {
		revision,
		heads: input.heads,
	})
	return true
}

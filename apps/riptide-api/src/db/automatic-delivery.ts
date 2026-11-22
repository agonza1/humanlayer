import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import {
	decodeDelivery,
	deliveryReviewVerdict,
	sameDeliveryHeads,
	type AutomaticDelivery,
	type DeliveryHead,
	type DeliveryReview,
} from '@humanlayer/schemas/zod/automatic-delivery'
import * as Sentry from '@sentry/node'
import { and, desc, eq, notInArray } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'

import { archiveTaskRows } from './archive-idle-task'
import { createSessionForLaunch } from './create-session-for-launch'

type Tx = PgDatabase<PostgresJsQueryResultHKT>
export type DeliveryTransaction = Tx
type Task = typeof tasks.$inferSelect
type Session = typeof sessions.$inferSelect

export async function lockDeliveryTask(tx: Tx, taskId: string, organizationId: string) {
	const [task] = await tx
		.select()
		.from(tasks)
		.where(and(eq(tasks.id, taskId), eq(tasks.organization_id, organizationId)))
		.for('no key update')
	return task
}

export async function deliveryContext(tx: Tx, task: Task, delivery: AutomaticDelivery) {
	const history = await tx
		.select()
		.from(sessions)
		.where(and(eq(sessions.task_id, task.id), eq(sessions.organization_id, task.organization_id)))
		.for('no key update')
	const pending = await tx
		.select({ id: queuedMessages.id })
		.from(queuedMessages)
		.where(
			and(
				eq(queuedMessages.task_id, task.id),
				eq(queuedMessages.organization_id, task.organization_id),
				eq(queuedMessages.status, 'pending'),
			),
		)
	const repos = await tx
		.select()
		.from(sessionRepositories)
		.where(
			and(
				eq(sessionRepositories.task_id, task.id),
				eq(sessionRepositories.organization_id, task.organization_id),
			),
		)
	const external = history.filter((session) => !delivery.deliverySessionIds.includes(session.id))
	const revision = JSON.stringify(
		external
			.map((session) => [
				session.id,
				session.status,
				String(session.last_activity_at),
				session.archived,
				String(session.created_at),
				session.num_events,
				session.prompt,
				session.working_directory,
				session.host_id,
			])
			.sort(),
	)
	const allIdle =
		history.every((session) => ['ready_for_input', 'failed', 'lost', 'interrupted'].includes(session.status)) &&
		pending.length === 0
	const untracked = repos.some(
		(repo) =>
			!repo.repo_full_name ||
			!repo.branch ||
			repo.host_id !== delivery.hostId ||
			!delivery.targets.some(
				(target) =>
					target.repository.toLowerCase() === repo.repo_full_name &&
					target.directory === repo.local_path &&
					(target.branch === repo.branch || target.base === repo.branch),
			),
	)
	return { history, revision: JSON.stringify([revision, task.ticket_description]), allIdle, untracked }
}

export async function saveDelivery(tx: Tx, task: Task, delivery: AutomaticDelivery) {
	await tx.update(tasks).set({ automatic_delivery: delivery }).where(eq(tasks.id, task.id))
}

async function launchDeliverySession(
	tx: Tx,
	task: Task,
	delivery: AutomaticDelivery,
	source: Session,
	kind: 'pr' | 'review' | 'repair' | 'attention',
) {
	const id = uuidv7()
	const safety =
		'Honor AGENTS.md, repository/company policy and required human checkpoints. You are a task worker: do not execute merges, enable GitHub auto-merge, archive tasks, delete worktrees or change credentials/permissions. The owning daemon handles explicitly authorized delivery. Worker restrictions do not themselves forbid the daemon from merging. Stop and report real blockers; never reset the delivery budget.'
	const targets = JSON.stringify(delivery.heads.length ? delivery.heads : delivery.targets)
	let prompt: string
	if (kind === 'pr')
		prompt = `Use the stock rpi:describe-pr skill to commit/push implementation and open or update the task PRs for ${targets}. ${safety}`
	else if (kind === 'repair')
		prompt = `Repair the verified PR-related P0/P1/P2 findings in this independent review: ${JSON.stringify(delivery.reviews.at(-1))}. First verify each PR is still open at its reviewed head; if it is already merged or changed independently, stop and report a follow-up instead of editing it. Run affected checks, self-review, commit and push to the existing branches. Resolve GitHub conversations only when the finding is verified fixed; retain evidence for disputed or unrelated findings. Do not claim an independent review of your own repairs. ${safety}`
	else if (kind === 'attention')
		prompt = `Main recovery/attention: delivery stopped: ${delivery.attention}. This is the only automatic diagnostic recovery attempt. Inspect task artifacts and GitHub, diagnose the blocker and report concrete recovery instructions in a task artifact. Use an available authorized notification route for a blocker needing owner attention; report notification failure. Do not use an owner CLI login, override policy, merge or restart delivery. Status snapshot: ${JSON.stringify(delivery)}. ${safety}`
	else {
		const example = JSON.stringify({
			sessionId: id,
			source: 'local-qa',
			verdict: 'clean',
			automaticMergeAllowed: true,
			humanCheckpointsSatisfied: true,
			heads: delivery.heads,
			findings: [],
			evidence: 'Actual checks, reviewed SHAs, review source/fallback reason and policy assessment',
		})
		prompt = `Delivery mode: ${delivery.mode}. In pr-only mode, the later manual merge is expected; it is not itself a missing prerequisite for technical QA. automaticMergeAllowed may be false in that mode. humanCheckpointsSatisfied covers human checkpoints required before this delivery stage, not the future manual merge. Independently review the complete diff, tests and existing PR reviews/conversations for ${targets}. This is pass ${delivery.passes} of at most three. You are a fresh session, not the implementer/repairer. Use completed current-head automatic review if configured and available; otherwise perform local QA yourself. Do not edit source, commit or push. Verify findings and their PR relevance; related P0/P1/P2 require repair. Unrelated verified P2/P3 remain linked in evidence for follow-up. Unrelated P0/P1, uncertainty, unavailable verification and missing human checkpoints require attention. Read task/repository/company policy: automaticMergeAllowed describes the owning daemon's merge authority, not your own worker role. Do not infer a missing human approval from task opt-in. Use the artifact write tool to save one complete JSON document in the task artifacts directory as delivery-review-${id}.json. The existing daemon sync authenticates the report; do not use or copy an owner CLI login. Shape: ${example}. source is automatic or local-qa; verdict is clean, repair, uncertain or blocked. findings contain priority (P0/P1/P2/P3), verified, related and reproducible detail/permalink. Set both policy booleans truthfully and include actual checks/failures and unresolved material findings in evidence. Never invent a pass. ${safety}`
	}
	if (kind === 'review') {
		prompt +=
			' Pending/running CI and a bounded CLI watch timeout are not failed CI or technical uncertainty by themselves. Continue bounded status waits within the existing task deadline; do not finalize uncertain solely because one watch call timed out. Never waive failed, missing or unverifiable required checks; report real blockers or checks still incomplete at the deadline honestly. Immediately before the final verdict, refresh each actual PR head, conversations/comments and review state; retain new related findings and invalidate affected evidence if inputs or findings changed.'
		const instructions = await tx
			.select({ content: conversationEvents.content })
			.from(conversationEvents)
			.where(
				and(
					eq(conversationEvents.task_id, task.id),
					eq(conversationEvents.organization_id, task.organization_id),
					eq(conversationEvents.role, 'user'),
					eq(conversationEvents.event_type, 'message'),
					delivery.deliverySessionIds.length
						? notInArray(conversationEvents.session_id, delivery.deliverySessionIds)
						: undefined,
				),
			)
			.orderBy(desc(conversationEvents.created_at))
			.limit(21)
		prompt += ` Accepted task description: ${task.ticket_description ?? ''}. Human task instructions, newest first: ${JSON.stringify(instructions.slice(0, 20))}. Later explicit human merge limits remain binding; worker-only restrictions describe your role, not the daemon's authority.`
		if (instructions.length > 20)
			prompt +=
				' Additional human task instructions exist: obtain the remaining history or report uncertainty; do not assume all policy checkpoints are satisfied.'
	}
	await createSessionForLaunch(tx, {
		deliveryManaged: true,
		id,
		taskId: task.id,
		organizationId: task.organization_id,
		resourceOwnerUserId: task.resource_owner_user_id,
		createdBy: task.resource_owner_user_id,
		title: `delivery ${kind}: ${task.name}`,
		prompt,
		workingDirectory: source.working_directory,
		hostId: delivery.hostId,
		codingAgent: source.coding_agent ?? 'claude',
		provider: source.provider ?? 'anthropic',
		model: source.model ?? 'opus',
		permissionsMode: source.permissions_mode ?? 'default',
		labels: [
			{
				name: kind === 'pr' ? 'rpi:describe-pr' : kind === 'repair' ? 'rpi:implementation' : 'rpi:review',
				title: kind,
			},
		],
	})
	delivery.managedSessionId = id
	delivery.managedAt = Date.now()
	delivery.deliverySessionIds.push(id)
}

export async function deliveryAttention(
	tx: Tx,
	task: Task,
	delivery: AutomaticDelivery,
	message: string,
	history: Session[],
) {
	if (delivery.phase !== 'attention') {
		delivery.attentionDuringPublication =
			delivery.phase === 'pr' ||
			(delivery.phase === 'inspect' && delivery.mode !== 'archive-only' && delivery.heads.length === 0)
	}
	delivery.phase = 'attention'
	if (delivery.attention !== message) delivery.blockerAlert = undefined
	delivery.attention = message
	delivery.lease = null
	const source = history.find((session) => session.id === delivery.sourceSessionId)
	if (
		delivery.recoveryAttempts === 0 &&
		source &&
		!source.archived &&
		history.every((session) => ['ready_for_input', 'failed', 'lost', 'interrupted'].includes(session.status))
	) {
		delivery.recoveryAttempts = 1
		await launchDeliverySession(tx, task, delivery, source, 'attention')
	} else if (delivery.recoveryAttempts > 0)
		delivery.attention = `${message} Automatic Main recovery is exhausted; task-owner attention required.`
	await saveDelivery(tx, task, delivery)
}

/** Called only by the existing authenticated host heartbeat continuation. One atomic action reservation. */
export async function claimTaskDelivery(tx: Tx, task: Task): Promise<DeliveryAction | null> {
	const delivery = decodeDelivery(task.automatic_delivery)
	if (!delivery || task.archived || delivery.phase === 'disabled' || delivery.phase === 'archived') return null
	const context = await deliveryContext(tx, task, delivery)
	const source = context.history.find((session) => session.id === delivery.sourceSessionId)
	if (!source || source.archived) {
		if (delivery.phase !== 'attention')
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Implementation source session is unavailable. Check the task before resuming.',
				context.history,
			)
		return null
	}
	if (
		delivery.phase === 'implementation' &&
		['failed', 'lost', 'interrupted', 'needs_approval'].includes(source.status)
	) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Implementation failed or requires a human checkpoint.',
			context.history,
		)
		return null
	}
	if (delivery.phase === 'attention') {
		if (delivery.recoveryAttempts === 0 && context.allIdle) {
			await deliveryAttention(
				tx,
				task,
				delivery,
				delivery.attention ?? 'Delivery requires attention.',
				context.history,
			)
			return null
		}
		const recovery = context.history.find((session) => session.id === delivery.managedSessionId)
		if (
			recovery &&
			(recovery.status === 'ready_for_input' ||
				['failed', 'lost', 'interrupted'].includes(recovery.status) ||
				Date.now() - delivery.managedAt > 30 * 60_000)
		) {
			delivery.attention = `${delivery.attention} Main recovery ended without automatic resolution (${recovery.status}); task-owner attention required. No further automatic recovery will run.`
			delivery.managedSessionId = null
			await saveDelivery(tx, task, delivery)
		}
		return null
	}
	if (delivery.lease) {
		if (delivery.lease.expiresAt > Date.now()) return null
		// Never repeat an uncertain irreversible action after a lost response or process death.
		if (delivery.lease.kind === 'merge') {
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Merge execution outcome is unknown after lease expiry; inspect GitHub before recovery.',
				context.history,
			)
			return null
		}
		delivery.lease = null
	}
	if (delivery.phase === 'pr' && !delivery.managedSessionId) {
		await deliveryAttention(tx, task, delivery, 'The Describe PR session is missing.', context.history)
		return null
	}
	if (delivery.managedSessionId) {
		const managed = context.history.find((session) => session.id === delivery.managedSessionId)
		if (
			!managed ||
			managed.archived ||
			['failed', 'lost', 'interrupted'].includes(managed.status) ||
			Date.now() - delivery.managedAt > 30 * 60_000
		) {
			await deliveryAttention(
				tx,
				task,
				delivery,
				delivery.phase === 'pr'
					? 'Describe PR stopped or exceeded its 30-minute deadline. Check the session before resuming.'
					: 'Managed continuation failed or exceeded its 30-minute bound.',
				context.history,
			)
			return null
		}
		if (delivery.phase === 'pr') {
			const hold =
				managed.status === 'needs_approval'
					? 'Describe PR needs approval. Open the session to review the request.'
					: managed.status === 'waiting_for_usage_limit'
						? 'Describe PR reached its usage limit. Check the session before resuming.'
						: null
			if (hold !== delivery.attention) {
				delivery.attention = hold
				delivery.blockerAlert = undefined
				await saveDelivery(tx, task, delivery)
			}
			if (hold) return null
		}
		if (managed.status !== 'ready_for_input') return null
		if (delivery.phase === 'repair' && managed.title?.startsWith('delivery review:')) {
			if (!context.allIdle) return null
			await launchDeliverySession(tx, task, delivery, source, 'repair')
			await saveDelivery(tx, task, delivery)
			return null
		}
		if (delivery.phase === 'review') {
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Independent review finished without valid exact-head evidence.',
				context.history,
			)
			return null
		}
		delivery.managedSessionId = null
		delivery.phase = 'inspect'
	}
	if (!context.allIdle) return null
	if (context.untracked) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Task has an untracked branch, repository, or host. All relevant work must be explicitly covered.',
			context.history,
		)
		return null
	}
	if (delivery.phase === 'implementation') {
		if (source.status !== 'ready_for_input') return null
		delivery.workRevision = context.revision
		delivery.phase = delivery.mode === 'archive-only' ? 'inspect' : 'pr'
		if (delivery.phase === 'pr') {
			try {
				await tx.transaction((savepoint) => launchDeliverySession(savepoint, task, delivery, source, 'pr'))
			} catch (error) {
				Sentry.captureException(error)
				delivery.phase = 'attention'
				delivery.attentionDuringPublication = true
				delivery.attention = 'Could not queue Describe PR. Check the task host and workspace.'
			}
			await saveDelivery(tx, task, delivery)
			return null
		}
	}
	if (context.revision !== delivery.workRevision) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Newer work or session activity invalidated delivery evidence.',
			context.history,
		)
		return null
	}
	const kind = delivery.phase === 'merge' ? 'merge' : delivery.phase === 'archive' ? 'archive' : 'inspect'
	// Also advances the persisted fairness timestamp when no managed session is live.
	delivery.managedAt = Date.now()
	delivery.lease = { id: uuidv7(), kind, expiresAt: Date.now() + 120_000, revision: context.revision }
	await saveDelivery(tx, task, delivery)
	return { taskId: task.id, leaseId: delivery.lease.id, kind, targets: delivery.targets, heads: delivery.heads }
}

export async function acceptDeliveryReview(tx: Tx, task: Task, review: DeliveryReview) {
	const delivery = decodeDelivery(task.automatic_delivery)
	if (
		!delivery ||
		delivery.phase !== 'review' ||
		delivery.managedSessionId !== review.sessionId ||
		review.sessionId === delivery.sourceSessionId ||
		!sameDeliveryHeads(delivery.heads, review.heads)
	)
		return false
	const context = await deliveryContext(tx, task, delivery)
	if (context.revision !== delivery.workRevision) return false
	if (!context.history.some((session) => session.id === review.sessionId && session.status === 'running'))
		return false
	delivery.reviews.push(review)
	const verdict = deliveryReviewVerdict(review)
	if (verdict === 'repair' && delivery.heads.some((head) => head.merged)) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Reviewed work is already merged. Record findings in a follow-up; do not repair the merged PR branch.',
			context.history,
		)
		return true
	}
	if (delivery.mode === 'merge' && !review.automaticMergeAllowed) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Independent review found a policy veto on automatic merge.',
			context.history,
		)
		return true
	}
	if (verdict === 'attention' || (verdict === 'repair' && delivery.passes >= 3)) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			verdict === 'attention'
				? 'Review is uncertain or blocked.'
				: 'Three review passes exhausted with findings requiring repair.',
			context.history,
		)
		return true
	}
	// The review session must stop before the heartbeat can launch repair or reserve a worker action.
	delivery.phase = verdict === 'repair' ? 'repair' : 'inspect'
	await saveDelivery(tx, task, delivery)
	return true
}

export async function completeTaskDelivery(
	tx: Tx,
	task: Task,
	leaseId: string,
	heads: DeliveryHead[],
	error: string | null,
) {
	const delivery = decodeDelivery(task.automatic_delivery)
	if (!delivery?.lease || delivery.lease.id !== leaseId) return false
	const lease = delivery.lease
	const context = await deliveryContext(tx, task, delivery)
	if (
		error ||
		lease.expiresAt < Date.now() ||
		!context.allIdle ||
		context.untracked ||
		context.revision !== lease.revision ||
		task.archived
	) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			error ?? 'Work changed or verification expired during delivery.',
			context.history,
		)
		return true
	}
	delivery.lease = null
	const matchesTargets =
		heads.length === delivery.targets.length &&
		delivery.targets.every((target) =>
			heads.some(
				(head) =>
					head.repository.toLowerCase() === target.repository.toLowerCase() &&
					head.branch === target.branch &&
					head.base === target.base,
			),
		)
	if (!matchesTargets) {
		await deliveryAttention(
			tx,
			task,
			delivery,
			'Fresh GitHub verification did not cover every authorized target.',
			context.history,
		)
		return true
	}
	const source = context.history.find((session) => session.id === delivery.sourceSessionId)
	if (!source) return false
	if (lease.kind === 'archive') {
		const review = delivery.reviews.at(-1)
		if (
			!heads.every((head) => head.merged) ||
			!review ||
			deliveryReviewVerdict(review) !== 'clean' ||
			!sameDeliveryHeads(review.heads, heads)
		) {
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Archive rejected: not all PRs are merged at independently reviewed exact heads.',
				context.history,
			)
			return true
		}
		delivery.phase = 'archived'
		await archiveTaskRows(tx, task.id, task.organization_id, true, true)
		await saveDelivery(tx, task, delivery)
		return true
	}
	const review = delivery.reviews.at(-1)
	delivery.heads = heads
	if (review && sameDeliveryHeads(review.heads, heads) && deliveryReviewVerdict(review) === 'clean') {
		if (heads.every((head) => head.merged)) delivery.phase = 'archive'
		else if (delivery.mode === 'merge') delivery.phase = 'merge'
		else delivery.phase = 'inspect'
	} else {
		if (delivery.mode === 'archive-only' && heads.some((head) => !head.merged)) {
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Archive-only authorization cannot merge an open PR.',
				context.history,
			)
			return true
		}
		if (delivery.passes >= 3) {
			await deliveryAttention(
				tx,
				task,
				delivery,
				'Changed heads or findings exhausted the three-pass review budget.',
				context.history,
			)
			return true
		}
		delivery.passes += 1
		delivery.phase = 'review'
		await launchDeliverySession(tx, task, delivery, source, 'review')
	}
	await saveDelivery(tx, task, delivery)
	return true
}

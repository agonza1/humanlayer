import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, asc, eq, exists, gt, isNotNull, lte, ne, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import z from 'zod/v4'

import { lockDeliveryTask } from '../db/automatic-delivery'
import { reserveDeliveryBlockerAlerts } from '../db/delivery-blocker-alerts'
import { hasLabel, reconcileImplementation } from '../db/implementation-reconciliation'
import type { AppRuntime } from '../effects/app-runtime'
import { Sentry } from '../instrument'
import { checkAutoAdvance } from '../orpc/daemon/sessions/check-auto-advance'
import { dispatchDeliveryAlerts } from './dispatch-delivery-alerts'

export const IMPLEMENTATION_RECONCILIATION_CHANNEL = 'riptide_implementation_reconciliation'
const BATCH_SIZE = 24
const taskWakeAt = sql<number>`(${tasks.implementation_reconciliation}->>'wakeAt')::bigint`
const EventSchema = z.discriminatedUnion('scope', [
	z.object({ scope: z.literal('task'), organizationId: z.uuid(), taskId: z.uuid() }),
	z.object({ scope: z.literal('workspace'), organizationId: z.uuid(), workspaceId: z.uuid() }),
	z.object({ scope: z.literal('project'), organizationId: z.uuid(), projectId: z.uuid() }),
	z.object({ scope: z.literal('host'), organizationId: z.uuid(), hostId: z.string(), ownerId: z.string() }),
	z.object({ scope: z.literal('branch'), organizationId: z.uuid(), repository: z.string(), branch: z.string() }),
])
type ReconciliationEvent = z.infer<typeof EventSchema>
type TaskKey = { taskId: string; organizationId: string }

async function recoverStockPublication(db: PostgresJsDatabase, effectRuntime: AppRuntime, task: TaskKey) {
	const candidates = await db
		.select({ id: sessions.id, labels: sessions.labels })
		.from(sessions)
		.innerJoin(tasks, and(eq(tasks.id, sessions.task_id), eq(tasks.organization_id, sessions.organization_id)))
		.innerJoin(
			onlineHosts,
			and(
				eq(onlineHosts.host_id, sessions.host_id),
				eq(onlineHosts.organization_id, tasks.organization_id),
				eq(onlineHosts.user_id, tasks.resource_owner_user_id),
				eq(onlineHosts.status, 'online'),
				gt(onlineHosts.last_seen, BigInt(Date.now() - 120_000)),
			),
		)
		.where(
			and(
				eq(tasks.id, task.taskId),
				eq(tasks.organization_id, task.organizationId),
				eq(tasks.archived, false),
				eq(tasks.is_draft, false),
				eq(tasks.auto_advance_implementation_to_pr, true),
				sql`${tasks.automatic_delivery} is null`,
				sql`${tasks.implementation_reconciliation} -> 'decision' ->> 'reason' = 'pr-missing'`,
				eq(sessions.archived, false),
				eq(sessions.status, 'ready_for_input'),
				eq(sessions.created_by, tasks.resource_owner_user_id),
			),
		)
		.orderBy(sql`${sessions.created_at} desc`, sql`${sessions.id} desc`)
		.limit(4)
	const source = candidates.find((candidate) => hasLabel(candidate, 'rpi:implementation'))
	if (source)
		await checkAutoAdvance(db, source.id, task.organizationId, effectRuntime, { recoverOwnerPublication: true })
}

export async function reconcileImplementationTask(db: PostgresJsDatabase, effectRuntime: AppRuntime, key: TaskKey) {
	// Stock publication owns dispatch. Its transaction re-checks authorization, sibling writers and
	// queue state. Reconciliation then re-reads its result under the same task lock.
	await recoverStockPublication(db, effectRuntime, key)
	const alerts = await db.transaction(async (tx) => {
		const task = await lockDeliveryTask(tx, key.taskId, key.organizationId)
		if (!task) return []
		await reconcileImplementation(tx, task)
		return reserveDeliveryBlockerAlerts(tx, task)
	})
	await dispatchDeliveryAlerts(db, effectRuntime, alerts)
}

function capture(error: unknown) {
	Sentry.captureException(error, { tags: { error_type: 'implementation_reconciliation' } })
}

export async function catchUpImplementationTasks(
	db: PostgresJsDatabase,
	effectRuntime: AppRuntime,
	event?: ReconciliationEvent | { scope: 'deadline'; cutoff: number },
	isStopped = () => false,
) {
	if (event?.scope === 'task') {
		if (!isStopped()) await reconcileImplementationTask(db, effectRuntime, event)
		return true
	}
	let after: string | undefined
	let completed = true
	while (!isStopped()) {
		const keys: TaskKey[] = await db
			.select({ taskId: tasks.id, organizationId: tasks.organization_id })
			.from(tasks)
			.where(
				and(
					eq(tasks.archived, false),
					eq(tasks.is_draft, false),
					after ? gt(tasks.id, after) : undefined,
					event?.scope === 'deadline'
						? lte(taskWakeAt, event.cutoff)
						: event && eq(tasks.organization_id, event.organizationId),
					event?.scope === 'workspace' ? eq(tasks.workspace_id, event.workspaceId) : undefined,
					event?.scope === 'project' ? eq(tasks.project_id, event.projectId) : undefined,
					event?.scope === 'host' ? eq(tasks.resource_owner_user_id, event.ownerId) : undefined,
					// A persisted deadline can outlive its last session while LISTEN is disconnected.
					// Both startup and due sweeps must reconcile those tasks and clear the stale wake.
					event?.scope === 'deadline'
						? undefined
						: or(
								!event ? isNotNull(tasks.implementation_reconciliation) : undefined,
								!event ? isNotNull(tasks.automatic_delivery) : undefined,
								exists(
									db
										.select({ id: sessions.id })
										.from(sessions)
										.where(
											and(
												eq(sessions.task_id, tasks.id),
												eq(sessions.organization_id, tasks.organization_id),
												eq(sessions.archived, false),
												ne(sessions.status, 'draft'),
												event?.scope === 'host'
													? eq(sessions.host_id, event.hostId)
													: undefined,
											),
										),
								),
							),
					event?.scope === 'branch'
						? exists(
								db
									.select({ id: sessionRepositories.id })
									.from(sessionRepositories)
									.where(
										and(
											eq(sessionRepositories.task_id, tasks.id),
											eq(sessionRepositories.organization_id, event.organizationId),
											eq(sessionRepositories.repo_full_name, event.repository),
											eq(sessionRepositories.branch, event.branch),
										),
									),
							)
						: undefined,
				),
			)
			.orderBy(asc(tasks.id))
			.limit(BATCH_SIZE)
		for (const key of keys) {
			if (isStopped()) return completed
			await reconcileImplementationTask(db, effectRuntime, key).catch((error) => {
				completed = false
				capture(error)
			})
		}
		if (keys.length < BATCH_SIZE) return completed
		after = keys.at(-1)?.taskId
	}
	return completed
}

/** One scoped observer in the API process. LISTEN reconnects also replay the bounded catch-up. */
export async function startImplementationReconciliation(
	db: PostgresJsDatabase,
	effectRuntime: AppRuntime,
	listen: (
		channel: string,
		onEvent: (event: string) => void,
		onReady: () => void,
	) => Promise<{ unlisten(): Promise<void> }>,
) {
	let stopped = false
	let pendingCatchUp = false
	let deadlineChanged = false
	let deadlineDue = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let draining: Promise<void> | undefined
	const events = new Map<string, ReconciliationEvent>()
	const isStopped = () => stopped
	let consecutiveDeadlineFailures = 0
	let retryDeadlinesAfter = 0
	const postponeDeadlines = () => {
		consecutiveDeadlineFailures = Math.min(consecutiveDeadlineFailures + 1, 7)
		retryDeadlinesAfter = Date.now() + Math.min(60_000, 1_000 * 2 ** (consecutiveDeadlineFailures - 1))
	}
	const setDeadlineTimer = (next: number) => {
		if (stopped) return
		const delay = Math.max(250, Math.max(next, retryDeadlinesAfter) - Date.now())
		timer = setTimeout(() => {
			deadlineDue = true
			wake()
		}, delay)
	}
	const armNextDeadline = async () => {
		if (timer) clearTimeout(timer)
		timer = undefined
		deadlineChanged = false
		try {
			const [row] = await db
				.select({ next: sql<string | null>`min(${taskWakeAt})` })
				.from(tasks)
				.where(and(eq(tasks.archived, false), eq(tasks.is_draft, false)))
			if (row?.next != null) setDeadlineTimer(Number(row.next))
		} catch (error) {
			capture(error)
			postponeDeadlines()
			setDeadlineTimer(retryDeadlinesAfter)
		}
	}
	const drain = async () => {
		while (!stopped && (pendingCatchUp || deadlineDue || events.size)) {
			if (deadlineDue) {
				deadlineDue = false
				const completed = await catchUpImplementationTasks(
					db,
					effectRuntime,
					{ scope: 'deadline', cutoff: Date.now() },
					isStopped,
				).catch((error) => {
					capture(error)
					return false
				})
				if (completed) {
					consecutiveDeadlineFailures = 0
					retryDeadlinesAfter = 0
				} else postponeDeadlines()
				continue
			}
			const next = events.entries().next().value
			if (next) {
				events.delete(next[0])
				await catchUpImplementationTasks(db, effectRuntime, next[1], isStopped).catch(capture)
			} else {
				pendingCatchUp = false
				await catchUpImplementationTasks(db, effectRuntime, undefined, isStopped).catch(capture)
			}
		}
		if (!stopped) await armNextDeadline()
	}
	const wake = () => {
		if (stopped || draining) return
		draining = drain().finally(() => {
			draining = undefined
			if (pendingCatchUp || deadlineDue || deadlineChanged || events.size) wake()
		})
	}
	const subscription = await listen(
		IMPLEMENTATION_RECONCILIATION_CHANNEL,
		(payload) => {
			if (payload === 'deadline') {
				deadlineChanged = true
				wake()
				return
			}
			try {
				const event = EventSchema.safeParse(JSON.parse(payload)).data
				if (!event) return
				if (events.size >= 512) {
					events.clear()
					pendingCatchUp = true
				}
				events.set(payload, event)
				wake()
			} catch (error) {
				capture(error)
			}
		},
		() => {
			pendingCatchUp = true
			wake()
		},
	)
	return async () => {
		stopped = true
		if (timer) clearTimeout(timer)
		events.clear()
		await subscription.unlisten()
		await draining
	}
}

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { projects } from '@humanlayer/db/tables/projects'
import { sessions } from '@humanlayer/db/tables/sessions'
import { slackIntegrations } from '@humanlayer/db/tables/slack-integrations'
import { slackNotificationAutomations } from '@humanlayer/db/tables/slack-notification-automations'
import { slackNotificationThreads } from '@humanlayer/db/tables/slack-notification-threads'
import type { tasks } from '@humanlayer/db/tables/tasks'
import {
	decodeDelivery,
	mergedAttentionObservation,
	MERGED_PR_ATTENTION,
	type AutomaticDelivery,
	type DeliveryAlertReceipt,
	type DeliveryAlertRoutesInputSchema,
	type DeliveryAlertSlackRoute,
} from '@humanlayer/schemas/zod/automatic-delivery'
import {
	IMPLEMENTATION_BLOCKERS,
	type ImplementationBlocker,
} from '@humanlayer/schemas/zod/implementation-reconciliation'
import { decodeTaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { and, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { z } from 'zod/v4'

import {
	resolveLocalSlackAlertRoute,
	resolveStandingLocalSlackAlertRoute,
	type LocalSlackTaskAttention,
	type PrivateSlackFields,
} from '../lib/local-slack-alert-relay'
import { deliveryContext, lockDeliveryTask, saveDelivery, type DeliveryTransaction } from './automatic-delivery'
import {
	readTaskReconciliation,
	reconcileImplementation,
	saveTaskReconciliation,
} from './implementation-reconciliation'
import { activeTaskAttention, isTaskAttentionIdleOnHost, saveTaskAttention } from './task-attention'

type Task = typeof tasks.$inferSelect
type AlertRoutes = NonNullable<AutomaticDelivery['alertRoutes']>
type BlockerAlert = NonNullable<AutomaticDelivery['blockerAlert']>
type AlertDelivery = Pick<BlockerAlert, 'id' | 'slack' | 'origin' | 'slackRoute' | 'standingSlackAttempt'>

const BLOCKER_REMINDER_INTERVAL_MS = 24 * 60 * 60_000
const SLOTS = ['slack', 'origin'] as const
type Slot = (typeof SLOTS)[number]

export type SlackBlockerDispatch = {
	taskId: string
	organizationId: string
	ownerId: string
	alertId: string
	taskAttention?: { id: string; hostId: string }
	teamId: string
	channelId: string
	threadTs?: string
	reason?: string
	relayReason?: 'publication' | 'implementation' | 'review'
	relayRouteId?: string
	standing?: { projectId: string; taskLabel: string; blocker?: ImplementationBlocker; revision: string }
	slots: Slot[]
}

async function findNativeOrigin(
	tx: DeliveryTransaction,
	task: Task,
	deliverySessionIds: readonly string[],
	sessionId: string,
) {
	if (deliverySessionIds.includes(sessionId)) return false
	const [origin] = await tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.task_id, task.id),
				eq(sessions.organization_id, task.organization_id),
				eq(sessions.resource_owner_user_id, task.resource_owner_user_id),
				eq(sessions.created_by, task.resource_owner_user_id),
				eq(sessions.archived, false),
			),
		)
	return Boolean(origin)
}

async function findSlackRoute(
	tx: DeliveryTransaction,
	task: Task,
	automationId: string,
	threadId?: string,
	discoverThread = true,
) {
	if (task.slack_notifications_muted) return null
	const [route] = await tx
		.select({
			teamId: slackIntegrations.slack_team_id,
			channelId: slackNotificationAutomations.channel_id,
			owners: slackNotificationAutomations.owner_user_ids,
		})
		.from(slackNotificationAutomations)
		.innerJoin(
			organizationSettings,
			and(
				eq(organizationSettings.organization_id, task.organization_id),
				eq(organizationSettings.slack_integration_enabled, true),
			),
		)
		.innerJoin(
			slackIntegrations,
			and(eq(slackIntegrations.organization_id, task.organization_id), eq(slackIntegrations.needs_reauth, false)),
		)
		.where(
			and(
				eq(slackNotificationAutomations.id, automationId),
				eq(slackNotificationAutomations.organization_id, task.organization_id),
				eq(slackNotificationAutomations.created_by_user_id, task.resource_owner_user_id),
				eq(slackNotificationAutomations.enabled, true),
			),
		)
	if (!route?.teamId || (route.owners?.length && !route.owners.includes(task.resource_owner_user_id))) return null

	const [thread] =
		threadId || discoverThread
			? await tx
					.select({ id: slackNotificationThreads.id, ts: slackNotificationThreads.root_thread_ts })
					.from(slackNotificationThreads)
					.where(
						and(
							eq(slackNotificationThreads.organization_id, task.organization_id),
							eq(slackNotificationThreads.task_id, task.id),
							eq(slackNotificationThreads.automation_id, automationId),
							eq(slackNotificationThreads.channel_id, route.channelId),
							eq(slackNotificationThreads.status, 'ready'),
							threadId ? eq(slackNotificationThreads.id, threadId) : undefined,
						),
					)
			: []
	if (threadId && !thread?.ts) return null

	return {
		binding: {
			localRelay: undefined,
			automationId,
			channelId: route.channelId,
			teamId: route.teamId,
			threadId: thread?.ts ? thread.id : undefined,
			threadTs: thread?.ts ?? undefined,
		},
		threadTs: thread?.ts ?? undefined,
	}
}

function findLocalSlackRoute(task: Task, automationId: string) {
	if (task.slack_notifications_muted) return null
	const pinned = resolveLocalSlackAlertRoute({
		routeId: automationId,
		organizationId: task.organization_id,
		ownerId: task.resource_owner_user_id,
		taskId: task.id,
	})
	return pinned
		? { binding: { automationId, ...pinned, localRelay: true as const, threadId: undefined }, threadTs: undefined }
		: null
}

/** Resolve each explicitly supplied route independently for the authorized task owner. */
export async function bindDeliveryAlertRoutes(
	tx: DeliveryTransaction,
	task: Task,
	deliverySessionIds: readonly string[],
	input: z.infer<typeof DeliveryAlertRoutesInputSchema>,
): Promise<AlertRoutes | null> {
	const routes: AlertRoutes = {}
	if (input.slackMode) routes.slackMode = input.slackMode
	if (input.slackAutomationId) {
		const slack =
			findLocalSlackRoute(task, input.slackAutomationId) ??
			(await findSlackRoute(tx, task, input.slackAutomationId))
		if (slack) routes.slack = slack.binding
	}
	if (
		input.origin?.kind === 'session' &&
		(await findNativeOrigin(tx, task, deliverySessionIds, input.origin.sessionId))
	) {
		routes.origin = input.origin
	}
	if (input.origin?.kind === 'slack') {
		const origin = await findSlackRoute(tx, task, input.origin.automationId)
		if (origin?.binding.threadId) routes.origin = { kind: 'slack', route: origin.binding }
	}
	if ((input.slackAutomationId || input.origin) && !routes.slack && !routes.origin && !routes.slackMode) return null
	return routes
}

async function resolveAuthorizedSlack(
	tx: DeliveryTransaction,
	task: Task,
	binding: DeliveryAlertSlackRoute,
): Promise<ResolvedSlackRoute | null> {
	const route = binding.localRelay
		? findLocalSlackRoute(task, binding.automationId)
		: await findSlackRoute(tx, task, binding.automationId, binding.threadId, false)
	if (
		!route ||
		route.binding.teamId !== binding.teamId ||
		route.binding.channelId !== binding.channelId ||
		route.binding.threadId !== binding.threadId ||
		route.threadTs !== binding.threadTs
	)
		return null
	return route
}

type ResolvedSlackRoute = {
	binding: DeliveryAlertSlackRoute
	threadTs?: string
	standing?: { projectId: string; revision: string }
}

async function resolveStandingSlack(tx: DeliveryTransaction, task: Task): Promise<ResolvedSlackRoute | null> {
	const projectId = task.project_id
	if (!projectId) return null
	const grant = resolveStandingLocalSlackAlertRoute({
		projectId,
		taskId: task.id,
		organizationId: task.organization_id,
		ownerId: task.resource_owner_user_id,
	})
	if (!grant) return null
	const [project] = await tx
		.select({ id: projects.id })
		.from(projects)
		.where(
			and(
				eq(projects.id, projectId),
				eq(projects.organization_id, task.organization_id),
				eq(projects.resource_owner_user_id, task.resource_owner_user_id),
				eq(projects.archived, false),
				isNull(projects.team_id),
			),
		)
	if (!project) return null
	return {
		binding: {
			automationId: grant.routeId,
			teamId: grant.teamId,
			channelId: grant.channelId,
			localRelay: true,
		},
		standing: { projectId, revision: grant.revision },
	}
}

async function effectiveSlack(tx: DeliveryTransaction, task: Task, routes: AlertRoutes | undefined) {
	if (task.slack_notifications_muted || routes?.slackMode === 'off') return { kind: 'off' as const, route: null }
	if (routes?.slack) return { kind: 'specific' as const, route: await resolveAuthorizedSlack(tx, task, routes.slack) }
	// Older saved route sets without Slack were explicit clears or origin-only opt-ins.
	if (routes && routes.slackMode !== 'inherit') return { kind: 'off' as const, route: null }
	const route = await resolveStandingSlack(tx, task)
	return { kind: route ? ('standing' as const) : ('unavailable' as const), route }
}

function slackDestination(teamId: string, channelId: string, threadTs?: string) {
	return JSON.stringify([teamId, channelId, threadTs])
}

type SlackDestination = {
	teamId: string
	channelId: string
	threadTs?: string
	relayRouteId?: string
	standing?: ResolvedSlackRoute['standing']
}

export function groupSlackBlockerSlots(inputs: readonly (SlackDestination & { slot: Slot })[]) {
	const groups = new Map<string, SlackDestination & { slots: Slot[] }>()
	for (const { slot, ...target } of inputs) {
		const key = slackDestination(target.teamId, target.channelId, target.threadTs)
		const existing = groups.get(key)
		if (existing) existing.slots.push(slot)
		else groups.set(key, { ...target, slots: [slot] })
	}
	return [...groups.values()]
}

function activeBlocker(tx: DeliveryTransaction, task: Task) {
	if (task.archived || task.is_draft) return null
	const delivery = decodeDelivery(task.automatic_delivery)
	if (delivery && ['attention', 'pr'].includes(delivery.phase) && delivery.attention) {
		return {
			state: delivery,
			delivery,
			routes: delivery.alertRoutes,
			reason: delivery.attention,
			slackReason: undefined,
			relayReason: undefined,
			relayBlocker: undefined,
			deliverySessionIds: delivery.deliverySessionIds,
			heldDescribePR: delivery.phase === 'pr' ? delivery.managedSessionId : undefined,
			reconciliation: false,
			save: () => saveDelivery(tx, task, delivery),
		}
	}
	const reconciliation = readTaskReconciliation(task)
	if (reconciliation.decision?.status !== 'blocked') return null
	const reason = IMPLEMENTATION_BLOCKERS[reconciliation.decision.reason]
	return {
		state: reconciliation,
		delivery: undefined,
		routes: reconciliation.alertRoutes ?? delivery?.alertRoutes,
		reason,
		slackReason: reason,
		relayReason: reconciliation.decision.stage === 'in-review' ? ('review' as const) : ('implementation' as const),
		relayBlocker: reconciliation.decision.reason,
		deliverySessionIds: delivery?.deliverySessionIds ?? [],
		heldDescribePR: undefined,
		reconciliation: true,
		save: () => saveTaskReconciliation(tx, task, reconciliation),
	}
}

type ActiveBlocker = NonNullable<ReturnType<typeof activeBlocker>>

function pendingAlert(): BlockerAlert {
	return { id: uuidv7(), slack: { status: 'pending' }, origin: { status: 'pending' } }
}

async function isExhaustedAndIdle(tx: DeliveryTransaction, task: Task, blocker: ActiveBlocker, now: number) {
	const { delivery } = blocker
	if (
		!delivery ||
		delivery.phase !== 'attention' ||
		delivery.authorizedBy !== task.resource_owner_user_id ||
		delivery.recoveryAttempts !== 1 ||
		delivery.managedSessionId ||
		(delivery.lease && delivery.lease.expiresAt > now)
	)
		return false
	const { allIdle, history } = await deliveryContext(tx, task, delivery)
	const source = history.find((session) => session.id === delivery.sourceSessionId)
	return (
		allIdle &&
		!!source &&
		!source.archived &&
		source.host_id === delivery.hostId &&
		source.created_by === task.resource_owner_user_id &&
		source.resource_owner_user_id === task.resource_owner_user_id
	)
}

function reminderReason(blocker: ActiveBlocker) {
	const diagnosis = blocker.delivery?.attentionDiagnosis
	if (mergedAttentionObservation(blocker.delivery)) return MERGED_PR_ATTENTION
	if (diagnosis) return [diagnosis.reason, diagnosis.nextAction].join(' ')
	return blocker.reason
}

type EffectiveSlack = Awaited<ReturnType<typeof effectiveSlack>>

function shouldRearmStandingSlack(alert: AlertDelivery, slack: EffectiveSlack) {
	const standing = slack.route?.standing
	return (
		!!standing &&
		(alert.slack.status === 'unavailable' || alert.slack.status === 'failed') &&
		alert.standingSlackAttempt !== standing.revision
	)
}

type AlertMessage = {
	routes?: AlertRoutes
	deliverySessionIds: readonly string[]
	nativeReason: string
	slackReason?: string
	relayReason?: SlackBlockerDispatch['relayReason']
	relayBlocker?: ImplementationBlocker
	standingPublication?: boolean
	taskLabel?: string
	taskAttention?: SlackBlockerDispatch['taskAttention']
}

function deliveryMessage(task: Task, blocker: ActiveBlocker, isReminder: boolean): AlertMessage {
	return {
		routes: blocker.routes,
		deliverySessionIds: blocker.deliverySessionIds,
		nativeReason: isReminder ? 'Still needs attention after 24 hours. ' + reminderReason(blocker) : blocker.reason,
		slackReason: isReminder ? 'Still needs attention after 24 hours.' : blocker.slackReason,
		relayReason: blocker.relayReason,
		relayBlocker: blocker.relayBlocker,
		standingPublication: blocker.heldDescribePR !== undefined,
		taskLabel: isReminder ? '24h reminder · ' + task.name : task.name,
	}
}

async function reserveAlertDelivery(
	tx: DeliveryTransaction,
	task: Task,
	message: AlertMessage,
	alert: AlertDelivery,
	slack: EffectiveSlack,
) {
	const { routes } = message
	const routingChanged = slack.kind !== alert.slackRoute
	alert.slackRoute = slack.kind
	// A route becoming available may rearm a known-unsent alert. Record the attempt
	// before dispatch so provider failures and observer replays do not resend it.
	if (shouldRearmStandingSlack(alert, slack)) alert.slack = { status: 'pending' }
	if (alert.slack.status !== 'pending' && alert.origin.status !== 'pending')
		return { changed: routingChanged, dispatches: [] }

	const targets: Parameters<typeof groupSlackBlockerSlots>[0][number][] = []
	const priorReceipts = [alert.slack, alert.origin]

	for (const slot of SLOTS) {
		if (alert[slot].status !== 'pending') continue
		if (slot === 'origin' && routes?.origin?.kind === 'session') {
			const sessionId = routes.origin.sessionId
			if (!(await findNativeOrigin(tx, task, message.deliverySessionIds, sessionId))) {
				alert.origin = { status: 'unavailable' }
				continue
			}
			const eventId = uuidv7()
			await tx.insert(conversationEvents).values({
				id: eventId,
				task_id: task.id,
				organization_id: task.organization_id,
				resource_owner_user_id: task.resource_owner_user_id,
				session_id: sessionId,
				event_type: 'system',
				role: 'system',
				content: JSON.stringify({
					kind: 'delivery_blocker',
					reason: message.nativeReason,
				}),
			})
			alert.origin = { status: 'delivered', receipt: eventId }
			continue
		}

		let route: ResolvedSlackRoute | null = slack.route
		if (slot === 'origin') {
			const origin = routes?.origin
			route = origin?.kind === 'slack' ? await resolveAuthorizedSlack(tx, task, origin.route) : null
		}
		if (!route) {
			alert[slot] = { status: 'unavailable' }
			continue
		}
		// This reservation survives a lost response or a crash. An uncertain
		// external post cannot safely be issued again.
		const destination = slackDestination(route.binding.teamId, route.binding.channelId, route.threadTs)
		const prior = priorReceipts.find(
			(receipt) =>
				(receipt.status === 'delivered' || receipt.status === 'unknown') && receipt.destination === destination,
		)
		if (prior) {
			alert[slot] = prior
			continue
		}
		alert[slot] = { status: 'unknown', destination }
		if (route.standing) alert.standingSlackAttempt = route.standing.revision
		targets.push({
			slot,
			teamId: route.binding.teamId,
			channelId: route.binding.channelId,
			threadTs: route.threadTs,
			relayRouteId: route.binding.localRelay ? route.binding.automationId : undefined,
			standing: route.standing,
		})
	}
	const dispatches = groupSlackBlockerSlots(targets).map(
		(target): SlackBlockerDispatch => ({
			...target,
			taskId: task.id,
			organizationId: task.organization_id,
			ownerId: task.resource_owner_user_id,
			alertId: alert.id,
			taskAttention: message.taskAttention,
			reason: message.slackReason,
			relayReason: target.standing && message.standingPublication ? 'publication' : message.relayReason,
			standing: target.standing
				? {
						...target.standing,
						taskLabel: message.taskLabel ?? task.name,
						blocker: message.relayBlocker,
					}
				: undefined,
		}),
	)
	return { changed: true, dispatches }
}

/** Runs under the stock task lock. Publish only reserved Slack work after commit. */
export async function reserveDeliveryBlockerAlerts(
	tx: DeliveryTransaction,
	task: Task,
	options: { checkReminder?: boolean } = {},
) {
	const blocker = activeBlocker(tx, task)
	if (!blocker) return []
	const alert = (blocker.state.blockerAlert ??= { ...pendingAlert(), openedAt: Date.now() })
	const slack = await effectiveSlack(tx, task, blocker.routes)
	const initial = await reserveAlertDelivery(tx, task, deliveryMessage(task, blocker, false), alert, slack)
	const dispatches = initial.dispatches
	let changed = initial.changed

	const now = Date.now()
	const anchor = alert.reminder?.reservedAt ?? alert.exhaustedAt
	const due = anchor !== undefined && now - anchor >= BLOCKER_REMINDER_INTERVAL_MS
	const reminder = alert.reminder
	const unsettled =
		reminder &&
		(reminder.slack.status === 'pending' ||
			reminder.origin.status === 'pending' ||
			shouldRearmStandingSlack(reminder, slack))
	if (
		options.checkReminder &&
		alert.acknowledgedAt === undefined &&
		(anchor === undefined || due || unsettled) &&
		(await isExhaustedAndIdle(tx, task, blocker, now))
	) {
		if (alert.exhaustedAt === undefined) {
			alert.exhaustedAt = now
			changed = true
		}
		if (due) {
			alert.reminder = { ...pendingAlert(), reservedAt: now }
			changed = true
		}
		if (alert.reminder) {
			const reserved = await reserveAlertDelivery(
				tx,
				task,
				deliveryMessage(task, blocker, true),
				alert.reminder,
				slack,
			)
			dispatches.push(...reserved.dispatches)
			changed ||= reserved.changed
		}
	}
	if (changed) await blocker.save()
	return dispatches
}

function authoredAttentionRoutes(task: Task) {
	return readTaskReconciliation(task).alertRoutes ?? decodeDelivery(task.automatic_delivery)?.alertRoutes
}

/** Caller holds the task lock and selected a due, idle task on the claiming owner's host. */
export async function reserveTaskAttentionAlert(tx: DeliveryTransaction, task: Task, hostId: string, now: number) {
	const attention = activeTaskAttention(task)
	if (
		!attention ||
		attention.acknowledgedAt !== undefined ||
		(attention.kind === 'external_wait' && (attention.followUpAt === undefined || attention.followUpAt > now))
	)
		return []

	const external = attention.kind === 'external_wait'
	const routes = authoredAttentionRoutes(task)
	const slack = await effectiveSlack(tx, task, routes)
	const notice = attention.notice ?? { ...pendingAlert(), reservedAt: now }
	const { changed, dispatches } = await reserveAlertDelivery(
		tx,
		task,
		{
			routes,
			deliverySessionIds: decodeDelivery(task.automatic_delivery)?.deliverySessionIds ?? [],
			nativeReason: [
				external ? 'External follow-up is due.' : 'Task owner input is needed.',
				attention.reason,
				attention.nextAction,
			].join(' '),
			// Explicit Slack routes receive a generic notice. The standing owner DM can include details after preflight.
			slackReason: external ? 'An external follow-up is due.' : 'The task needs owner input.',
			taskLabel: (external ? 'Follow-up due · ' : 'Owner input needed · ') + task.name,
			taskAttention: { id: attention.id, hostId },
		},
		notice,
		slack,
	)
	if (changed) {
		attention.notice = notice
		await saveTaskAttention(tx, task, attention)
	}
	return dispatches
}

/** Rearm only confirmed unsent slots explicitly rebound by the task owner. */
export async function rearmTaskAttentionRoutes(tx: DeliveryTransaction, task: Task, routes: AlertRoutes) {
	const attention = activeTaskAttention(task)
	if (!attention?.notice || attention.acknowledgedAt !== undefined) return
	const { notice } = attention
	let changed = false
	for (const slot of SLOTS) {
		const configured = slot === 'slack' ? routes.slack : routes.origin
		if (configured && ['unavailable', 'failed'].includes(notice[slot].status)) {
			notice[slot] = { status: 'pending' }
			changed = true
		}
	}
	if (changed) await saveTaskAttention(tx, task, attention)
}

/** Caller holds the task lock and has verified the current owner's identity. */
export async function acknowledgeDeliveryBlocker(tx: DeliveryTransaction, task: Task, alertId: string) {
	const blocker = activeBlocker(tx, task)
	const alert = blocker?.state.blockerAlert
	if (!blocker || !alert || alert.id !== alertId) return false
	if (alert.acknowledgedAt === undefined) {
		alert.acknowledgedAt = Date.now()
		await blocker.save()
	}
	return true
}

function dispatchAlert(alert: BlockerAlert, alertId: string) {
	if (alert.id === alertId) return alert
	if (alert.reminder?.id === alertId) return alert.reminder
	return undefined
}

export async function validateSlackBlockerDispatch(
	tx: DeliveryTransaction,
	dispatch: SlackBlockerDispatch,
): Promise<{ slots: Slot[] } & PrivateSlackFields> {
	const task = await lockDeliveryTask(tx, dispatch.taskId, dispatch.organizationId)
	if (!task || task.resource_owner_user_id !== dispatch.ownerId) return { slots: [] }
	const authored = dispatch.taskAttention
	let alert: AlertDelivery | undefined
	let routes: AlertRoutes | undefined
	let currentAttention: LocalSlackTaskAttention | undefined
	let guidance: string | undefined
	let githubUrl = task.ticket_provider === 'github' ? (task.ticket_url ?? undefined) : undefined
	if (authored) {
		const attention = activeTaskAttention(task)
		if (
			!attention ||
			attention.id !== authored.id ||
			attention.notice?.id !== dispatch.alertId ||
			attention.acknowledgedAt !== undefined ||
			(attention.kind === 'external_wait' &&
				(attention.followUpAt === undefined || attention.followUpAt > Date.now())) ||
			!(await isTaskAttentionIdleOnHost(tx, task, authored.hostId))
		)
			return { slots: [] }
		alert = attention.notice
		routes = authoredAttentionRoutes(task)
		const { kind, reason, responsible, nextAction, followUpAt } = attention
		currentAttention = { kind, reason, responsible, nextAction, followUpAt }
	} else {
		let blocker = activeBlocker(tx, task)
		if (blocker?.reconciliation) {
			await reconcileImplementation(tx, task)
			blocker = activeBlocker(tx, task)
		}
		const primary = blocker?.state.blockerAlert
		if (!blocker || !primary) return { slots: [] }
		alert = dispatchAlert(primary, dispatch.alertId)
		if (!alert) return { slots: [] }
		if (
			alert !== primary &&
			(primary.acknowledgedAt !== undefined || !(await isExhaustedAndIdle(tx, task, blocker, Date.now())))
		)
			return { slots: [] }
		if (blocker.heldDescribePR !== undefined) {
			if (!blocker.heldDescribePR) return { slots: [] }
			const [managed] = await tx
				.select({ status: sessions.status, archived: sessions.archived })
				.from(sessions)
				.where(and(eq(sessions.id, blocker.heldDescribePR), eq(sessions.task_id, task.id)))
			if (!managed || managed.archived || !['needs_approval', 'waiting_for_usage_limit'].includes(managed.status))
				return { slots: [] }
		}
		if (blocker.delivery) {
			guidance = reminderReason(blocker)
			const heads = blocker.delivery.attentionObservation?.heads ?? blocker.delivery.heads
			const head = heads.length === 1 ? heads[0] : undefined
			if (head) githubUrl = `https://github.com/${head.repository}/pull/${head.number}`
		}
		routes = blocker.routes
	}

	const slots: Slot[] = []
	const destination = slackDestination(dispatch.teamId, dispatch.channelId, dispatch.threadTs)
	for (const slot of dispatch.slots) {
		const retained = alert[slot]
		if (retained.status !== 'unknown' || retained.destination !== destination) continue
		const origin = routes?.origin
		let current: ResolvedSlackRoute | null = null
		if (slot === 'slack') current = (await effectiveSlack(tx, task, routes)).route
		else if (origin?.kind === 'slack') current = await resolveAuthorizedSlack(tx, task, origin.route)
		if (
			!current ||
			current.binding.teamId !== dispatch.teamId ||
			current.binding.channelId !== dispatch.channelId ||
			current.threadTs !== dispatch.threadTs ||
			(current.binding.localRelay ? current.binding.automationId : undefined) !== dispatch.relayRouteId ||
			current.standing?.revision !== dispatch.standing?.revision ||
			current.standing?.projectId !== dispatch.standing?.projectId
		)
			continue
		slots.push(slot)
	}
	return dispatch.standing && slots.length ? { slots, attention: currentAttention, guidance, githubUrl } : { slots }
}

export async function finishSlackBlockerDispatch(
	tx: DeliveryTransaction,
	dispatch: SlackBlockerDispatch,
	outcome: { kind: 'provider'; result: DeliveryAlertReceipt } | { kind: 'preflight'; canceled: boolean },
) {
	const task = await lockDeliveryTask(tx, dispatch.taskId, dispatch.organizationId)
	if (!task || task.resource_owner_user_id !== dispatch.ownerId) return
	let alert: AlertDelivery | undefined
	let save: () => Promise<unknown>
	if (dispatch.taskAttention) {
		// Keep a real receipt if an alert was sent just before the owner cleared or acknowledged it.
		const attention = decodeTaskAttention(task.task_attention)
		if (
			!attention ||
			attention.authorizedBy !== dispatch.ownerId ||
			attention.id !== dispatch.taskAttention.id ||
			attention.notice?.id !== dispatch.alertId
		)
			return
		alert = attention.notice
		save = () => saveTaskAttention(tx, task, attention)
	} else {
		const blocker = activeBlocker(tx, task)
		const primary = blocker?.state.blockerAlert
		if (!blocker || !primary) return
		alert = dispatchAlert(primary, dispatch.alertId)
		save = blocker.save
	}
	if (!alert) return

	const destination = slackDestination(dispatch.teamId, dispatch.channelId, dispatch.threadTs)
	const result = outcome.kind === 'provider' ? outcome.result : { status: 'unavailable' as const }
	for (const slot of SLOTS) {
		const retained = alert[slot]
		if (retained.status !== 'unknown' || retained.destination !== destination) continue
		if (!dispatch.slots.includes(slot) && outcome.kind === 'preflight') {
			// A coalesced slot may retry only when preflight canceled the whole send.
			if (outcome.canceled) alert[slot] = { status: 'pending' }
			continue
		}
		alert[slot] = result.status === 'delivered' || result.status === 'unknown' ? { ...result, destination } : result
	}
	await save()
}

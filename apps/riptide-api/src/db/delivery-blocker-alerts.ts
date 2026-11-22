import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { sessions } from '@humanlayer/db/tables/sessions'
import { slackIntegrations } from '@humanlayer/db/tables/slack-integrations'
import { slackNotificationAutomations } from '@humanlayer/db/tables/slack-notification-automations'
import { slackNotificationThreads } from '@humanlayer/db/tables/slack-notification-threads'
import type { tasks } from '@humanlayer/db/tables/tasks'
import {
	decodeDelivery,
	type AutomaticDelivery,
	type DeliveryAlertReceipt,
	type DeliveryAlertRoutesInputSchema,
	type DeliveryAlertSlackRoute,
} from '@humanlayer/schemas/zod/automatic-delivery'
import { and, eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { z } from 'zod/v4'

import { lockDeliveryTask, saveDelivery, type DeliveryTransaction } from './automatic-delivery'

type Task = typeof tasks.$inferSelect
type AlertRoutes = NonNullable<AutomaticDelivery['alertRoutes']>
const SLOTS = ['slack', 'origin'] as const
type Slot = (typeof SLOTS)[number]

export type SlackBlockerDispatch = {
	taskId: string
	organizationId: string
	ownerId: string
	alertId: string
	teamId: string
	channelId: string
	threadTs?: string
	slots: Slot[]
}

async function findNativeOrigin(tx: DeliveryTransaction, task: Task, delivery: AutomaticDelivery, sessionId: string) {
	if (delivery.deliverySessionIds.includes(sessionId)) return false
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
			automationId,
			channelId: route.channelId,
			teamId: route.teamId,
			threadId: thread?.ts ? thread.id : undefined,
			threadTs: thread?.ts ?? undefined,
		},
		threadTs: thread?.ts ?? undefined,
	}
}

/** Resolve each explicitly supplied route independently for the authorized task owner. */
export async function bindDeliveryAlertRoutes(
	tx: DeliveryTransaction,
	task: Task,
	delivery: AutomaticDelivery,
	input: z.infer<typeof DeliveryAlertRoutesInputSchema>,
): Promise<AlertRoutes | null> {
	const routes: AlertRoutes = {}
	if (input.slackAutomationId) {
		const slack = await findSlackRoute(tx, task, input.slackAutomationId)
		if (slack) routes.slack = slack.binding
	}
	if (input.origin?.kind === 'session' && (await findNativeOrigin(tx, task, delivery, input.origin.sessionId))) {
		routes.origin = input.origin
	}
	if (input.origin?.kind === 'slack') {
		const origin = await findSlackRoute(tx, task, input.origin.automationId)
		if (origin?.binding.threadId) routes.origin = { kind: 'slack', route: origin.binding }
	}
	if ((input.slackAutomationId || input.origin) && !routes.slack && !routes.origin) return null
	return routes
}

async function resolveAuthorizedSlack(tx: DeliveryTransaction, task: Task, binding: DeliveryAlertSlackRoute) {
	const route = await findSlackRoute(tx, task, binding.automationId, binding.threadId, false)
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

function slackDestination(teamId: string, channelId: string, threadTs?: string) {
	return JSON.stringify([teamId, channelId, threadTs])
}

export function groupSlackBlockerSlots(
	inputs: readonly { slot: Slot; teamId: string; channelId: string; threadTs?: string }[],
) {
	const groups = new Map<string, { teamId: string; channelId: string; threadTs?: string; slots: Slot[] }>()
	for (const { slot, teamId, channelId, threadTs } of inputs) {
		const key = slackDestination(teamId, channelId, threadTs)
		const existing = groups.get(key)
		if (existing) existing.slots.push(slot)
		else groups.set(key, { teamId, channelId, threadTs, slots: [slot] })
	}
	return [...groups.values()]
}

/** Runs under the stock delivery task lock. Publish only reserved Slack work after commit. */
export async function reserveDeliveryBlockerAlerts(tx: DeliveryTransaction, task: Task, delivery: AutomaticDelivery) {
	if (!['attention', 'pr'].includes(delivery.phase) || !delivery.attention || task.archived) return []
	const routes = delivery.alertRoutes
	const alert = (delivery.blockerAlert ??= {
		id: uuidv7(),
		slack: { status: 'pending' },
		origin: { status: 'pending' },
	})
	if (alert.slack.status !== 'pending' && alert.origin.status !== 'pending') return []
	const targets: Parameters<typeof groupSlackBlockerSlots>[0][number][] = []
	const priorReceipts = [alert.slack, alert.origin]

	for (const slot of SLOTS) {
		if (alert[slot].status !== 'pending') continue
		if (slot === 'origin' && routes?.origin?.kind === 'session') {
			const sessionId = routes.origin.sessionId
			if (!(await findNativeOrigin(tx, task, delivery, sessionId))) {
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
					reason: delivery.attention,
				}),
			})
			alert.origin = { status: 'delivered', receipt: eventId }
			continue
		}

		const binding =
			slot === 'slack' ? routes?.slack : routes?.origin?.kind === 'slack' ? routes.origin.route : undefined
		const route = binding && (await resolveAuthorizedSlack(tx, task, binding))
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
		targets.push({
			slot,
			teamId: route.binding.teamId,
			channelId: route.binding.channelId,
			threadTs: route.threadTs,
		})
	}
	await saveDelivery(tx, task, delivery)
	return groupSlackBlockerSlots(targets).map(
		(target): SlackBlockerDispatch => ({
			...target,
			taskId: task.id,
			organizationId: task.organization_id,
			ownerId: task.resource_owner_user_id,
			alertId: alert.id,
		}),
	)
}

export async function validateSlackBlockerDispatch(tx: DeliveryTransaction, dispatch: SlackBlockerDispatch) {
	const task = await lockDeliveryTask(tx, dispatch.taskId, dispatch.organizationId)
	const delivery = decodeDelivery(task?.automatic_delivery)
	if (
		!task ||
		task.archived ||
		task.resource_owner_user_id !== dispatch.ownerId ||
		!delivery ||
		!['attention', 'pr'].includes(delivery.phase) ||
		delivery.blockerAlert?.id !== dispatch.alertId
	)
		return []
	if (delivery.phase === 'pr') {
		if (!delivery.managedSessionId) return []
		const [managed] = await tx
			.select({ status: sessions.status, archived: sessions.archived })
			.from(sessions)
			.where(and(eq(sessions.id, delivery.managedSessionId), eq(sessions.task_id, task.id)))
		if (!managed || managed.archived || !['needs_approval', 'waiting_for_usage_limit'].includes(managed.status))
			return []
	}

	const authorized: Slot[] = []
	const destination = slackDestination(dispatch.teamId, dispatch.channelId, dispatch.threadTs)
	for (const slot of dispatch.slots) {
		const origin = delivery.alertRoutes?.origin
		const binding =
			slot === 'slack' ? delivery.alertRoutes?.slack : origin?.kind === 'slack' ? origin.route : undefined
		const retained = delivery.blockerAlert[slot]
		if (!binding || retained.status !== 'unknown' || retained.destination !== destination) continue
		const current = await resolveAuthorizedSlack(tx, task, binding)
		if (
			!current ||
			current.binding.teamId !== dispatch.teamId ||
			current.binding.channelId !== dispatch.channelId ||
			current.threadTs !== dispatch.threadTs
		)
			continue
		authorized.push(slot)
	}
	return authorized
}

export async function finishSlackBlockerDispatch(
	tx: DeliveryTransaction,
	dispatch: SlackBlockerDispatch,
	outcome: { kind: 'provider'; result: DeliveryAlertReceipt } | { kind: 'preflight'; canceled: boolean },
) {
	const task = await lockDeliveryTask(tx, dispatch.taskId, dispatch.organizationId)
	const delivery = decodeDelivery(task?.automatic_delivery)
	if (!task || task.resource_owner_user_id !== dispatch.ownerId || delivery?.blockerAlert?.id !== dispatch.alertId)
		return
	const destination = slackDestination(dispatch.teamId, dispatch.channelId, dispatch.threadTs)
	const result = outcome.kind === 'provider' ? outcome.result : { status: 'unavailable' as const }
	for (const slot of SLOTS) {
		const retained = delivery.blockerAlert[slot]
		if (retained.status !== 'unknown' || retained.destination !== destination) continue
		if (!dispatch.slots.includes(slot) && outcome.kind === 'preflight') {
			// A coalesced slot may retry only when preflight canceled the whole send.
			if (outcome.canceled) delivery.blockerAlert[slot] = { status: 'pending' }
			continue
		}
		delivery.blockerAlert[slot] =
			result.status === 'delivered' || result.status === 'unknown' ? { ...result, destination } : result
	}
	await saveDelivery(tx, task, delivery)
}

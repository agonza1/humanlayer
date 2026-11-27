import type { BoardAttention, BoardDelivery, BoardStatus } from '@humanlayer/schemas/task-board'

import { SESSION_STATUS_LABELS } from './session-status-labels'

const DAY_MS = 24 * 60 * 60 * 1000
const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DATE_AND_TIME = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
})
const FULL_DATE_AND_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function boardStatusLabel(status: BoardStatus): string {
	return status === 'not_started' ? 'Not started' : SESSION_STATUS_LABELS[status]
}

export function boardDeliveryLabel(delivery: BoardDelivery) {
	if (delivery.status === 'blocked') return 'Blocked'
	if (delivery.status === 'verifying') return `Verifying PR · Due ${FULL_DATE_AND_TIME.format(delivery.deadlineAt)}`
	if (delivery.status === 'review') return 'Independent review verified'
	if (delivery.status === 'running') return 'Describe PR running'
	return delivery.deadlineAt === undefined
		? 'Describe PR queued'
		: `Describe PR queued · Due ${FULL_DATE_AND_TIME.format(delivery.deadlineAt)}`
}

const alertStateLabels = {
	delivered: 'delivered',
	pending: 'pending',
	failed: 'failed',
	unavailable: 'unavailable',
	unknown: 'unconfirmed',
} as const

const slackRouteLabels = {
	standing: 'standing route',
	specific: 'task route',
	off: 'route off',
	unavailable: 'no route',
} as const

export function boardDeliveryAlertLabel(delivery: BoardDelivery) {
	if (delivery.status !== 'blocked' || !delivery.alert) return null
	return boardAttentionAlertLabel(delivery.alert)
}

export function boardAttentionAlertLabel(alert: NonNullable<BoardAttention['alert']>) {
	const { slack, origin, slackRoute, reminder } = alert
	if (!slackRoute && slack === 'delivered' && origin === 'delivered' && !reminder) return null
	const route = slackRoute ? ` (${slackRouteLabels[slackRoute]})` : ''
	const initial = `Slack alert ${alertStateLabels[slack]}${route} · Origin alert ${alertStateLabels[origin]}`
	if (!reminder) return initial
	return `${initial} · 24h reminder: Slack ${alertStateLabels[reminder.slack]}, origin ${alertStateLabels[reminder.origin]}`
}

export function boardAttentionGapLabel(alert: BoardAttention['alert']) {
	if (!alert) return null
	const isGap = (status: typeof alert.slack) => status !== 'delivered' && status !== 'pending'
	return isGap(alert.slack) || isGap(alert.origin) ? boardAttentionAlertLabel(alert) : null
}

export function boardAttentionLabel(attention: BoardAttention) {
	if (attention.kind === 'owner_input') return 'Needs input'
	if (attention.kind === 'external_wait')
		return attention.responsible ? `Waiting on ${attention.responsible}` : 'Waiting externally'
	return 'Blocked'
}

export function boardAttentionFollowUpLabel(item: BoardAttention, nowMs: number) {
	const { followUpAt, followUpHost: host } = item
	if (followUpAt === undefined || item.resolvedAt !== undefined) return null
	const date = FULL_DATE_AND_TIME.format(followUpAt)
	if (followUpAt > nowMs || item.acknowledgedAt !== undefined) return `Follow-up ${date}`
	if (item.lastNoticeAt !== undefined && !host) return `Follow-up scheduled for ${date} · Notice attempted ${FULL_DATE_AND_TIME.format(item.lastNoticeAt)}`
	const due = `Follow-up due · ${date}`
	if (!host) return due
	if (host.status === 'unknown') return `${due} · Assigned host status unavailable`
	const state = host.status === 'stale' ? 'heartbeat late' : host.status
	return `${due} · Assigned host ${state} · Last heartbeat ${FULL_DATE_AND_TIME.format(host.lastHeartbeatAt)}`
}

export function boardIdleBackground(status: BoardStatus | undefined, updatedAtMs: number | null | undefined, nowMs: number) {
	return status === 'ready_for_input' && updatedAtMs != null && nowMs - updatedAtMs > DAY_MS
		? 'rgba(150, 24, 36, 0.09)'
		: undefined
}

export function formatBoardUpdateTime(updatedAtMs: number, nowMs: number) {
	const updatedAt = new Date(updatedAtMs)
	const full = FULL_DATE_AND_TIME.format(updatedAt)
	let label = CLOCK_TIME.format(updatedAt)
	if (nowMs - updatedAtMs >= DAY_MS) {
		label = updatedAt.getFullYear() === new Date(nowMs).getFullYear() ? DATE_AND_TIME.format(updatedAt) : full
	}
	return { label, full, dateTime: updatedAt.toISOString() }
}

import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { DeliveryAlertReceipt } from '@humanlayer/schemas/zod/automatic-delivery'
import { z } from 'zod/v4'

type RouteScope = { routeId: string; organizationId: string; ownerId: string; taskId: string }
type LocalSlackAlert = RouteScope & {
	alertId: string
	teamId: string
	channelId: string
	reason?: 'publication' | 'implementation' | 'review' | 'delivery'
}

const localRouteSchema = z.object({
	routeId: z.uuid(),
	taskId: z.uuid(),
	organizationId: z.string().min(1),
	ownerId: z.string().min(1),
	appOrigin: z.url(),
	teamId: z.string().regex(/^T[A-Z0-9]+$/),
	channelId: z.string().regex(/^D[A-Z0-9]+$/),
	botUserId: z.string().regex(/^U[A-Z0-9]+$/),
	recipientUserId: z.string().regex(/^U[A-Z0-9]+$/),
	executable: z.string().refine(isAbsolute),
	script: z.string().refine(isAbsolute),
	providerConfigFile: z.string().refine(isAbsolute),
})

const localReceiptSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('delivered'),
		taskId: z.uuid(),
		alertId: z.uuid(),
		teamId: z.string(),
		channelId: z.string(),
		botUserId: z.string(),
		messageTs: z.string().regex(/^\d+\.\d+$/),
	}),
	z.object({ status: z.enum(['unavailable', 'failed', 'unknown']) }),
])

function readLocalRoute(scope: RouteScope) {
	const path = process.env.HUMANLAYER_LOCAL_SLACK_ALERT_RELAY_FILE
	if (!path || !isAbsolute(path)) return null
	try {
		const metadata = lstatSync(path)
		if (
			!metadata.isFile() ||
			metadata.uid !== process.getuid?.() ||
			(metadata.mode & 0o077) !== 0 ||
			metadata.size > 4096
		)
			return null
		const route = localRouteSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
		const origin = new URL(route.appOrigin)
		if (
			!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
			!['http:', 'https:'].includes(origin.protocol) ||
			route.appOrigin !== origin.origin ||
			route.appOrigin !== process.env.APP_ORIGIN ||
			route.routeId !== scope.routeId ||
			route.organizationId !== scope.organizationId ||
			route.ownerId !== scope.ownerId ||
			route.taskId !== scope.taskId
		)
			return null
		return route
	} catch {
		return null
	}
}

export function resolveLocalSlackAlertRoute(scope: RouteScope) {
	const route = readLocalRoute(scope)
	return route ? { teamId: route.teamId, channelId: route.channelId } : null
}

/** The local runner owns the Slack token. Only IDs, an allowlisted reason, and a receipt cross this boundary. */
export function postLocalSlackDeliveryBlocker(input: LocalSlackAlert): Promise<DeliveryAlertReceipt> {
	const route = readLocalRoute(input)
	if (!route || route.teamId !== input.teamId || route.channelId !== input.channelId)
		return Promise.resolve({ status: 'unavailable' })

	const request = {
		...input,
		botUserId: route.botUserId,
		recipientUserId: route.recipientUserId,
		taskUrl: new URL(`/tasks/${input.taskId}`, route.appOrigin).toString(),
	}
	return new Promise((resolve) => {
		const child = execFile(
			route.executable,
			[route.script, route.providerConfigFile],
			{ encoding: 'utf8', timeout: 21_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
			(error, output) => {
				try {
					if (error) return resolve({ status: 'unknown' })
					const result = localReceiptSchema.parse(JSON.parse(output))
					if (result.status !== 'delivered') return resolve(result)
					if (
						result.taskId !== input.taskId ||
						result.alertId !== input.alertId ||
						result.teamId !== input.teamId ||
						result.channelId !== input.channelId ||
						result.botUserId !== route.botUserId
					)
						return resolve({ status: 'unknown' })
					return resolve({
						status: 'delivered',
						receipt: `${result.teamId}/${result.channelId}/${result.messageTs}`,
					})
				} catch {
					return resolve({ status: 'unknown' })
				}
			},
		)
		child.stdin?.on('error', () => undefined)
		child.stdin?.end(JSON.stringify(request))
	})
}

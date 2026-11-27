import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { DeliveryAlertReceipt } from '@humanlayer/schemas/zod/automatic-delivery'
import {
	IMPLEMENTATION_BLOCKERS,
	type ImplementationBlocker,
} from '@humanlayer/schemas/zod/implementation-reconciliation'
import { TaskAttentionInputSchema, type TaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { z } from 'zod/v4'

type RouteScope = { routeId: string; organizationId: string; ownerId: string; taskId: string }
type StandingScope = Omit<RouteScope, 'routeId'> & { projectId: string }
export type LocalSlackTaskAttention = Pick<
	TaskAttention,
	'kind' | 'reason' | 'responsible' | 'nextAction' | 'followUpAt'
>
export type PrivateSlackFields = { attention?: LocalSlackTaskAttention; guidance?: string; githubUrl?: string }
type LocalSlackAlert = RouteScope & {
	alertId: string
	teamId: string
	channelId: string
	reason?: 'publication' | 'implementation' | 'review' | 'delivery'
	standing?: PrivateSlackFields & {
		projectId: string
		taskLabel: string
		blocker?: ImplementationBlocker
		revision: string
	}
}

const MAX_ROUTE_FILE_BYTES = 4096
const GITHUB_TASK =
	/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?:issues|pull)\/[1-9]\d{0,15}$/u
const id = z.uuid()
const localRouteSchema = z.object({
	routeId: id,
	taskId: id,
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

const standingRouteSchema = localRouteSchema
	.omit({ taskId: true })
	.extend({
		schemaVersion: z.literal(2),
		projectIds: z
			.array(id)
			.min(1)
			.refine((projects) => new Set(projects).size === projects.length),
	})
	.strict()

const deliveredReceiptSchema = z.object({
	status: z.literal('delivered'),
	taskId: id,
	alertId: id,
	teamId: z.string(),
	channelId: z.string(),
	botUserId: z.string(),
	messageTs: z.string().regex(/^\d+\.\d+$/),
})
const undeliveredReceiptSchema = z.object({ status: z.enum(['unavailable', 'failed', 'unknown']) })
const localReceiptSchema = z.discriminatedUnion('status', [deliveredReceiptSchema, undeliveredReceiptSchema])
const standingReceiptSchema = z.discriminatedUnion('status', [
	deliveredReceiptSchema
		.extend({
			schemaVersion: z.literal(2),
			projectId: id,
			routeId: id,
			messageTs: z.string().regex(/^\d{10,16}\.\d{6}$/),
		})
		.strict(),
	undeliveredReceiptSchema,
])

function readPrivateRouteFile<Schema extends z.ZodType>(path: string | undefined, schema: Schema) {
	if (!path || !isAbsolute(path)) return null
	try {
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		try {
			const before = fstatSync(fd)
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.uid !== process.getuid?.() ||
				(before.mode & 0o077) !== 0 ||
				before.size > MAX_ROUTE_FILE_BYTES
			)
				return null
			const bytes = Buffer.alloc(MAX_ROUTE_FILE_BYTES + 1)
			let length = 0
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, null)
				if (count === 0) break
				length += count
			}
			const after = fstatSync(fd)
			if (
				length !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				return null
			return schema.parse(JSON.parse(bytes.toString('utf8', 0, length)))
		} finally {
			closeSync(fd)
		}
	} catch {
		return null
	}
}

function matchesLocalAppOrigin(appOrigin: string) {
	const origin = new URL(appOrigin)
	return (
		['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
		['http:', 'https:'].includes(origin.protocol) &&
		appOrigin === origin.origin &&
		appOrigin === process.env.APP_ORIGIN
	)
}

function readLocalRoute(scope: RouteScope) {
	const route = readPrivateRouteFile(process.env.HUMANLAYER_LOCAL_SLACK_ALERT_RELAY_FILE, localRouteSchema)
	if (
		!route ||
		!matchesLocalAppOrigin(route.appOrigin) ||
		route.routeId !== scope.routeId ||
		route.organizationId !== scope.organizationId ||
		route.ownerId !== scope.ownerId ||
		route.taskId !== scope.taskId
	)
		return null
	return route
}

function readStandingGrant(scope: Pick<StandingScope, 'organizationId' | 'ownerId'>) {
	const route = readPrivateRouteFile(
		process.env.HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE,
		standingRouteSchema,
	)
	if (
		!route ||
		!matchesLocalAppOrigin(route.appOrigin) ||
		route.botUserId === route.recipientUserId ||
		route.organizationId !== scope.organizationId ||
		route.ownerId !== scope.ownerId
	)
		return null
	const revision = createHash('sha256')
		.update(JSON.stringify({ ...route, projectIds: [...new Set(route.projectIds)].sort() }))
		.digest('hex')
	return { route, revision }
}

function readStandingRoute(scope: StandingScope) {
	const standing = readStandingGrant(scope)
	return standing?.route.projectIds.includes(scope.projectId) && id.safeParse(scope.taskId).success ? standing : null
}

export function standingSlackAttentionScope(scope: Pick<StandingScope, 'organizationId' | 'ownerId'>) {
	const standing = readStandingGrant(scope)
	return standing ? { projectIds: standing.route.projectIds, revision: standing.revision } : null
}

export function resolveLocalSlackAlertRoute(scope: RouteScope) {
	const route = readLocalRoute(scope)
	return route ? { teamId: route.teamId, channelId: route.channelId } : null
}

export function resolveStandingLocalSlackAlertRoute(scope: StandingScope) {
	const standing = readStandingRoute(scope)
	if (!standing) return null
	const { routeId, teamId, channelId } = standing.route
	return { routeId, teamId, channelId, revision: standing.revision }
}

function plainText(value: string, limit: number) {
	return value
		.replace(/[\p{Cc}\p{Bidi_Control}\p{Cs}]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, limit)
		.replace(/\p{Cs}$/u, '')
		.trimEnd()
}

function normalizeAttention(attention: LocalSlackTaskAttention | undefined) {
	if (!attention) return undefined
	return TaskAttentionInputSchema.safeParse({
		kind: attention.kind,
		reason: plainText(attention.reason, 500),
		responsible: plainText(attention.responsible, 160),
		nextAction: plainText(attention.nextAction, 500),
		followUpAt: attention.followUpAt,
	}).data
}

/** The local runner owns the Slack token. The relay receives only the approved destination and notice fields. */
export function postLocalSlackDeliveryBlocker(input: LocalSlackAlert): Promise<DeliveryAlertReceipt> {
	const { standing } = input
	const standingRoute = standing ? readStandingRoute({ ...input, projectId: standing.projectId }) : null
	const route = standing ? standingRoute?.route : readLocalRoute(input)
	if (
		!route ||
		route.routeId !== input.routeId ||
		route.teamId !== input.teamId ||
		route.channelId !== input.channelId ||
		(standing &&
			(standingRoute?.revision !== standing.revision ||
				(standing.blocker !== undefined && !Object.hasOwn(IMPLEMENTATION_BLOCKERS, standing.blocker))))
	)
		return Promise.resolve({ status: 'unavailable' })

	const commonRequest = {
		routeId: input.routeId,
		organizationId: input.organizationId,
		ownerId: input.ownerId,
		taskId: input.taskId,
		alertId: input.alertId,
		teamId: input.teamId,
		channelId: input.channelId,
		reason: input.reason,
		botUserId: route.botUserId,
		recipientUserId: route.recipientUserId,
		taskUrl: new URL(`/tasks/${input.taskId}`, route.appOrigin).toString(),
	}
	const request = standing
		? {
				...commonRequest,
				schemaVersion: 2,
				projectId: standing.projectId,
				taskLabel:
					plainText(standing.taskLabel.replace(/[\p{C}<>&]/gu, ' '), 120) || `Task ${input.taskId.slice(-8)}`,
				blocker: standing.blocker,
				attention: normalizeAttention(standing.attention),
				guidance: plainText(standing.guidance ?? '', 1000) || undefined,
				githubUrl: standing.githubUrl && GITHUB_TASK.test(standing.githubUrl) ? standing.githubUrl : undefined,
			}
		: commonRequest
	return new Promise((resolve) => {
		const child = execFile(
			route.executable,
			[route.script, route.providerConfigFile],
			{ encoding: 'utf8', timeout: 21_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
			(error, output) => {
				try {
					if (error) return resolve({ status: 'unknown' })
					const result = (standing ? standingReceiptSchema : localReceiptSchema).parse(JSON.parse(output))
					if (result.status !== 'delivered') return resolve(result)
					if (
						result.taskId !== input.taskId ||
						result.alertId !== input.alertId ||
						result.teamId !== input.teamId ||
						result.channelId !== input.channelId ||
						result.botUserId !== route.botUserId ||
						(standing &&
							(!('routeId' in result) ||
								!('projectId' in result) ||
								result.routeId !== input.routeId ||
								result.projectId !== standing.projectId))
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

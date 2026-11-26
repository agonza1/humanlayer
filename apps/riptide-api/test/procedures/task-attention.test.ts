import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { sessions } from '@humanlayer/db/tables/sessions'
import { slackIntegrations } from '@humanlayer/db/tables/slack-integrations'
import { slackNotificationAutomations } from '@humanlayer/db/tables/slack-notification-automations'
import { tasks } from '@humanlayer/db/tables/tasks'
import type { TaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer } from 'effect'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AppRuntime } from '../../src/effects/app-runtime'
import { SlackService } from '../../src/effects/services/slack/slack.service'
import {
	acknowledgeTaskAttentionProcedure,
	clearTaskAttentionProcedure,
	setTaskAttentionProcedure,
} from '../../src/orpc/api/tasks/attention'
import { configureDeliveryAlertsProcedure } from '../../src/orpc/api/tasks/delivery'
import { claimDeliveryProcedure } from '../../src/orpc/daemon/delivery'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { createRuntimeWithTestPostgresLayer, fakeSlackLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const confirmed = { status: 'delivered', receipt: 'T_TEST/C_TEST/1710000000.000002' } as const
const externalWait = {
	kind: 'external_wait' as const,
	reason: 'Provider campaign limits need confirmation.',
	responsible: 'SignalWire',
	nextAction: 'Confirm the counting window.',
}
const ownerInput = {
	kind: 'owner_input' as const,
	reason: 'Approve the system design.',
	responsible: 'Task owner',
	nextAction: 'Accept or request edits to the design.',
}
const key = ({ id, revision }: TaskAttention) => ({ id, revision })

describe('Authored task attention', () => {
	let db: PostgresJsDatabase
	let runtime: AppRuntime
	let cleanup: () => Promise<void>
	const sends: Array<{ reason?: string }> = []

	beforeAll(async () => {
		const testDb = await createTestDb('task_attention')
		db = testDb.db
		cleanup = testDb.cleanup
		const slack = Layer.effect(
			SlackService,
			Effect.gen(function* () {
				const service = yield* SlackService
				return {
					...service,
					sendDeliveryBlocker: (input: Parameters<typeof service.sendDeliveryBlocker>[0]) =>
						Effect.sync(() => {
							sends.push(input)
							return confirmed
						}),
				}
			}),
		).pipe(Layer.provide(fakeSlackLayer))
		runtime = createRuntimeWithTestPostgresLayer(db, { slack })
	}, 30_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	})

	async function fixture(routes: 'none' | 'native' | 'both' = 'none', withSession = true) {
		const [org] = await db
			.insert(organizations)
			.values({ name: 'Attention test', workos_organization_id: uuidv7() })
			.returning()
		const organizationId = org!.id
		const userId = 'attention-owner'
		const hostId = uuidv7()
		const otherHost = uuidv7()
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: 'Task with an authored wait',
				created_by: userId,
				resource_owner_user_id: userId,
			})
			.returning()
		const taskId = task!.id
		const [origin] = withSession
			? await db
					.insert(sessions)
					.values({
						organization_id: organizationId,
						task_id: taskId,
						created_by: userId,
						resource_owner_user_id: userId,
						host_id: hostId,
						working_directory: '/tmp/task-attention-fixture',
						status: 'ready_for_input',
					})
					.returning()
			: []
		const api = (caller = userId) => ({
			context: createMockApiContext({
				auth: createMockApiAuth({ organizationId, userId: caller }),
				services: { db, dbReadReplica: db, effectRuntime: runtime },
			}),
		})
		const daemon = (host = hostId) => ({
			context: createMockDaemonContext({
				auth: createMockDaemonAuth({ organizationId, userId, hostId: host }),
				services: { db, dbReadReplica: db, effectRuntime: runtime },
			}),
		})
		let slackAutomationId: string | undefined
		if (routes === 'both') {
			await db
				.insert(organizationSettings)
				.values({ organization_id: organizationId, slack_integration_enabled: true })
			await db.insert(slackIntegrations).values({
				organization_id: organizationId,
				slack_team_id: 'T_TEST',
				bot_access_token: 'test-only',
				bot_user_id: 'B_TEST',
				scopes: 'chat:write',
				connected_by_user_id: userId,
			})
			const [automation] = await db
				.insert(slackNotificationAutomations)
				.values({
					name: 'Test blocker routing',
					organization_id: organizationId,
					channel_id: 'C_TEST',
					event_types: ['comment'],
					created_by_user_id: userId,
				})
				.returning()
			slackAutomationId = automation!.id
			await call(
				configureDeliveryAlertsProcedure,
				{
					taskId,
					routes: { slackAutomationId: automation!.id, origin: { kind: 'session', sessionId: origin!.id } },
				},
				api(),
			)
		} else if (routes === 'native') {
			await call(
				configureDeliveryAlertsProcedure,
				{
					taskId,
					routes: { slackMode: 'off', origin: { kind: 'session', sessionId: origin!.id } },
				},
				api(),
			)
		}
		return {
			taskId,
			organizationId,
			userId,
			hostId,
			otherHost,
			origin,
			slackAutomationId,
			api,
			heartbeat: (host?: string) => call(claimDeliveryProcedure, { supportsObservation: true }, daemon(host)),
			read: async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!,
			notices: () => db.select().from(conversationEvents).where(eq(conversationEvents.task_id, taskId)),
			set: (
				attention: typeof externalWait | typeof ownerInput | (typeof externalWait & { followUpAt: number }),
				expected: { id: string; revision: number } | null = null,
			) => call(setTaskAttentionProcedure, { taskId, attention, expected }, api()),
		}
	}

	it('requires the owner and current occurrence revision, retaining the acknowledged and cleared state', async () => {
		const f = await fixture('none', false)
		const input = { taskId: f.taskId, expected: null, attention: ownerInput }
		await expect(call(setTaskAttentionProcedure, input, f.api('viewer'))).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		const { attention } = await call(setTaskAttentionProcedure, input, f.api())
		await expect(call(setTaskAttentionProcedure, input, f.api())).rejects.toMatchObject({ code: 'CONFLICT' })
		const { attention: acked } = await call(
			acknowledgeTaskAttentionProcedure,
			{ taskId: f.taskId, ...key(attention!) },
			f.api(),
		)
		expect(acked).toMatchObject({ id: attention!.id, revision: 2, acknowledgedAt: expect.any(Number) })
		await f.heartbeat(f.otherHost)
		expect((await f.read()).task_attention?.notice).toBeUndefined()
		await expect(
			call(clearTaskAttentionProcedure, { taskId: f.taskId, ...key(attention!) }, f.api()),
		).rejects.toMatchObject({ code: 'CONFLICT' })
		const { attention: cleared } = await call(
			clearTaskAttentionProcedure,
			{ taskId: f.taskId, ...key(acked!) },
			f.api(),
		)
		expect(cleared).toMatchObject({ id: attention!.id, revision: 3, resolvedAt: expect.any(Number) })
		const { attention: reopened } = await f.set(ownerInput)
		expect(reopened!.id).not.toBe(attention!.id)
		// There is no task host yet, so any authenticated owner host can claim the notice once.
		await Promise.all([f.heartbeat(), f.heartbeat(f.otherHost)])
		expect((await f.read()).task_attention?.notice).toMatchObject({
			slack: { status: 'unavailable' },
			origin: { status: 'unavailable' },
		})
	})

	it('processes a due external follow-up once on the idle owner host and keeps both confirmed receipts', async () => {
		const f = await fixture('both')
		const initialSends = sends.length
		const { attention } = await f.set({ ...externalWait, followUpAt: Date.now() + 60_000 })
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice).toBeUndefined()
		const followUpAt = Date.now() - 100
		const { attention: due } = await f.set({ ...externalWait, followUpAt }, key(attention!))
		await f.heartbeat(f.otherHost)
		expect((await f.read()).task_attention?.notice).toBeUndefined()
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.origin!.id))
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice).toBeUndefined()
		await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.origin!.id))
		const [queued] = await db
			.insert(queuedMessages)
			.values({
				task_id: f.taskId,
				session_id: f.origin!.id,
				organization_id: f.organizationId,
				resource_owner_user_id: f.userId,
				content: 'Wait for the existing workflow.',
			})
			.returning()
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice).toBeUndefined()
		await db.update(queuedMessages).set({ status: 'delivered' }).where(eq(queuedMessages.id, queued!.id))

		const before = await f.read()
		await Promise.all([f.heartbeat(), f.heartbeat()])
		const reported = await f.read()
		const notices = await f.notices()
		expect(notices).toHaveLength(1)
		expect(JSON.parse(notices[0]!.content!)).toEqual({
			kind: 'delivery_blocker',
			reason: 'External follow-up is due. Provider campaign limits need confirmation. Confirm the counting window.',
		})
		expect(reported.updated_at).toBe(before.updated_at)
		expect(reported.task_attention).toMatchObject({
			id: due!.id,
			revision: due!.revision,
			updatedAt: due!.updatedAt,
			notice: { slack: confirmed, origin: { status: 'delivered', receipt: notices[0]!.id } },
		})
		expect(sends.slice(initialSends)).toHaveLength(1)
		expect(sends.at(-1)?.reason).toBe('An external follow-up is due.')

		const { attention: edited } = await f.set(
			{ ...externalWait, reason: 'Same dependency, updated evidence.', followUpAt },
			key(due!),
		)
		await f.heartbeat()
		expect(edited!.notice?.id).toBe(reported.task_attention?.notice?.id)
		expect(await f.notices()).toHaveLength(1)
		expect(sends.slice(initialSends)).toHaveLength(1)

		const { attention: acked } = await call(
			acknowledgeTaskAttentionProcedure,
			{ taskId: f.taskId, ...key(edited!) },
			f.api(),
		)
		const { attention: moved } = await f.set({ ...externalWait, followUpAt: followUpAt - 1 }, key(acked!))
		expect(moved!.id).toBe(acked!.id)
		expect(moved!.acknowledgedAt).toBeUndefined()
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice?.id).not.toBe(edited!.notice!.id)
		expect(await f.notices()).toHaveLength(2)
		expect(sends.slice(initialSends)).toHaveLength(2)
	})

	it('reports a missing Slack route while still notifying the authorized native origin', async () => {
		const f = await fixture('native')
		const initial = sends.length
		await f.set(ownerInput)
		await f.heartbeat()
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice).toMatchObject({
			slackRoute: 'off',
			slack: { status: 'unavailable' },
			origin: { status: 'delivered' },
		})
		expect(await f.notices()).toHaveLength(1)
		expect(sends).toHaveLength(initial)
	})
	it('rearms known unsent slots on route repair and preserves confirmed receipts', async () => {
		const f = await fixture('both')
		const start = sends.length
		const origin = { kind: 'session' as const, sessionId: f.origin!.id }
		await call(
			configureDeliveryAlertsProcedure,
			{ taskId: f.taskId, routes: { slackMode: 'off', origin } },
			f.api(),
		)
		await f.set(ownerInput)
		await f.heartbeat()
		const before = (await f.read()).task_attention!.notice!
		expect(before).toMatchObject({ slack: { status: 'unavailable' }, origin: { status: 'delivered' } })
		const rebind = () =>
			call(
				configureDeliveryAlertsProcedure,
				{ taskId: f.taskId, routes: { slackAutomationId: f.slackAutomationId!, origin } },
				f.api(),
			)
		await rebind()
		await f.heartbeat()
		await rebind()
		await f.heartbeat()
		expect((await f.read()).task_attention!.notice).toMatchObject({
			id: before.id,
			reservedAt: before.reservedAt,
			origin: before.origin,
			slack: confirmed,
		})
		expect(await f.notices()).toHaveLength(1)
		expect(sends.slice(start)).toHaveLength(1)
	})

	it('rearms after a new standing grant and does not reissue an uncertain acknowledgement', async () => {
		const f = await fixture('none', false)
		const [project] = await db
			.insert(projects)
			.values({
				name: 'Attention project',
				organization_id: f.organizationId,
				created_by: f.userId,
				resource_owner_user_id: f.userId,
				repositories: [],
			})
			.returning()
		await db.update(tasks).set({ project_id: project!.id }).where(eq(tasks.id, f.taskId))
		const directory = await mkdtemp(join(tmpdir(), 'task-attention-standing-'))
		const grant = join(directory, 'route.json')
		const appOrigin = 'http://127.0.0.1:5175'
		const route = {
			schemaVersion: 2,
			routeId: uuidv7(),
			organizationId: f.organizationId,
			ownerId: f.userId,
			projectIds: [project!.id],
			appOrigin,
			teamId: 'TSTANDING',
			channelId: 'DSTANDING',
			botUserId: 'USTANDINGBOT',
			recipientUserId: 'USTANDINGOWNER',
			executable: '/bin/false',
			script: '/unused-provider',
			providerConfigFile: '/unused-config',
		}
		vi.stubEnv('APP_ORIGIN', appOrigin)
		vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', grant)
		try {
			await f.set(ownerInput)
			await f.heartbeat()
			const before = (await f.read()).task_attention!.notice!
			expect(before.slack).toEqual({ status: 'unavailable' })
			await writeFile(grant, JSON.stringify(route), { mode: 0o600 })
			await f.heartbeat()
			const attempt = (await f.read()).task_attention!.notice!
			expect(attempt).toMatchObject({
				id: before.id,
				reservedAt: before.reservedAt,
				slackRoute: 'standing',
				slack: { status: 'unknown' },
				standingSlackAttempt: expect.any(String),
			})
			await writeFile(grant, JSON.stringify({ ...route, routeId: uuidv7() }), { mode: 0o600 })
			await f.heartbeat()
			expect((await f.read()).task_attention!.notice).toEqual(attempt)
		} finally {
			vi.unstubAllEnvs()
			await rm(directory, { recursive: true, force: true })
		}
	})
})

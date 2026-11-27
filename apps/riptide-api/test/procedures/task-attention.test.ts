import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { artifacts } from '@humanlayer/db/tables/artifacts'
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
import { hash } from 'ohash'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { lockDeliveryTask } from '../../src/db/automatic-delivery'
import { reserveTaskAttentionAlert, validateSlackBlockerDispatch } from '../../src/db/delivery-blocker-alerts'
import type { AppRuntime } from '../../src/effects/app-runtime'
import { SlackService } from '../../src/effects/services/slack/slack.service'
import { syncTasksProcedure } from '../../src/orpc/api/sync/tasks'
import {
	acknowledgeTaskAttentionProcedure,
	clearTaskAttentionProcedure,
	setTaskAttentionProcedure,
} from '../../src/orpc/api/tasks/attention'
import { configureDeliveryAlertsProcedure } from '../../src/orpc/api/tasks/delivery'
import { upsertArtifactProcedure } from '../../src/orpc/daemon/artifacts/upsert'
import { claimDeliveryProcedure } from '../../src/orpc/daemon/delivery'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { createRuntimeWithTestPostgresLayer, fakeSlackLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const bridgeRelay = process.env.HUMANLAYER_SLACK_E2E_RELAY
const exec = promisify(execFile)
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
			daemon,
			heartbeat: (host?: string) => call(claimDeliveryProcedure, { supportsObservation: true }, daemon(host)),
			read: async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!,
			notices: () => db.select().from(conversationEvents).where(eq(conversationEvents.task_id, taskId)),
			set: (
				attention: typeof externalWait | typeof ownerInput | (typeof externalWait & { followUpAt: number }),
				expected: { id: string; revision: number } | null = null,
			) => call(setTaskAttentionProcedure, { taskId, attention, expected }, api()),
		}
	}

	it.each([
		['prd', 'solution-review'],
		['tdd', 'system-design-review'],
		['tdd', 'program-design-review'],
	])('records a single owner decision at the %s %s checkpoint', async (kind, gate) => {
		const f = await fixture('native')
		const stem = `04-${kind}-team-calling`
		const type = `design-${kind}`
		const input = { taskId: f.taskId, sessionId: f.origin!.id, operationType: 'Write' as const }
		await db
			.update(sessions)
			.set({ status: 'running', labels: [{ name: `rpi:${type}`, title: type }] })
			.where(eq(sessions.id, f.origin!.id))
		await call(
			upsertArtifactProcedure,
			{ ...input, fileName: `${stem}.md`, content: 'Design', frontmatter: { type } },
			f.daemon(),
		)
		const decision = {
			question: 'Approve the call admission design?',
			recommendation: 'Use PostgreSQL.',
			nextAction: 'Start program design after approval.',
		}
		const fileFor = (text: string) => `${stem}.${gate}.${createHash('sha256').update(text).digest('hex')}.json`
		const checkpoint = { ...input, fileName: fileFor('Design'), content: JSON.stringify(decision) }
		const write = () => call(upsertArtifactProcedure, checkpoint, f.daemon())
		await expect(call(upsertArtifactProcedure, checkpoint, f.daemon(f.otherHost))).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		await expect(
			call(upsertArtifactProcedure, { ...checkpoint, operationType: 'Read' }, f.daemon()),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		await expect(
			call(upsertArtifactProcedure, { ...checkpoint, content: '{"approved":true}' }, f.daemon()),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		const revised = { ...checkpoint, fileName: fileFor('Revised') }
		await expect(call(upsertArtifactProcedure, revised, f.daemon())).rejects.toMatchObject({ code: 'BAD_REQUEST' })

		await f.set(externalWait)
		const wait = (await f.read()).task_attention!
		await expect(write()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		expect((await f.read()).task_attention).toEqual(wait)
		await call(clearTaskAttentionProcedure, { taskId: f.taskId, ...key(wait) }, f.api())
		// A prior generic upload with the same name cannot forge a checkpoint receipt.
		await db.insert(artifacts).values({
			task_id: f.taskId,
			organization_id: f.organizationId,
			created_by: f.userId,
			resource_owner_user_id: f.userId,
			file_name: checkpoint.fileName,
			content: checkpoint.content,
			content_hash: hash(checkpoint.content),
		})

		const receipts = await Promise.all([write(), write()])
		expect(receipts[0].artifactId).toBe(receipts[1].artifactId)
		const record = (await f.read()).task_attention!
		expect(record).toMatchObject({
			kind: 'owner_input',
			reason: decision.question + ' Recommendation: ' + decision.recommendation,
			nextAction: decision.nextAction,
			responsible: 'Task owner',
			evidence: stem + '.md',
			revision: 1,
		})
		expect((await f.notices()).length).toBe(0)
		await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.origin!.id))
		await f.heartbeat()
		expect((await f.read()).task_attention?.notice?.origin.status).toBe('delivered')
		await call(clearTaskAttentionProcedure, { taskId: f.taskId, ...key(record) }, f.api())
		const resolved = (await f.read()).task_attention!
		await write()
		expect((await f.read()).task_attention).toEqual(resolved)
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.origin!.id))
		await call(
			upsertArtifactProcedure,
			{ ...input, fileName: stem + '.md', content: 'Revised', frontmatter: { type } },
			f.daemon(),
		)
		await call(upsertArtifactProcedure, revised, f.daemon())
		const current = (await f.read()).task_attention!
		expect(current.id).not.toBe(record.id)
		await write()
		expect((await f.read()).task_attention).toEqual(current)
	})

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
		expect(sends.at(-1)).not.toHaveProperty('attention')
		expect(sends.at(-1)).not.toHaveProperty('standing.attention')

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

	async function standingGrant(f: Awaited<ReturnType<typeof fixture>>, script?: string) {
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
			executable: script ? process.execPath : '/bin/false',
			script: script ?? '/unused-provider',
			providerConfigFile: script ? join(directory, 'provider.json') : '/unused-config',
		}
		vi.stubEnv('APP_ORIGIN', appOrigin)
		vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', grant)
		return { directory, grant, route }
	}

	it('rearms after a new standing grant and does not reissue an uncertain acknowledgement', async () => {
		const f = await fixture('none', false)
		const { directory, grant, route } = await standingGrant(f)
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

	it('prepares the current authored details only for a still-due private dispatch', async () => {
		const f = await fixture('none', false)
		const { directory, grant, route } = await standingGrant(f)
		try {
			await writeFile(grant, JSON.stringify(route), { mode: 0o600 })
			const followUpAt = Date.now() - 100
			const { attention } = await f.set({ ...externalWait, followUpAt })
			const [dispatch] = await db.transaction(async (tx) => {
				const task = await lockDeliveryTask(tx, f.taskId, f.organizationId)
				return reserveTaskAttentionAlert(tx, task!, f.hostId, Date.now())
			})
			expect(dispatch).toBeDefined()

			const revised = { ...externalWait, nextAction: 'Ask the provider for the exact window.', followUpAt }
			const withEvidence = { ...revised, evidence: 'Private meeting notes.' }
			const { attention: current } = await f.set(withEvidence, key(attention!))
			const preflight = () => db.transaction((tx) => validateSlackBlockerDispatch(tx, dispatch!))
			expect(await preflight()).toEqual({ slots: ['slack'], attention: revised })

			await f.set({ ...revised, followUpAt: Date.now() + 60_000 }, key(current!))
			expect(await preflight()).toEqual({ slots: [] })
		} finally {
			vi.unstubAllEnvs()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it.skipIf(!bridgeRelay)(
		'delivers a due private Slack alert once and answers a reply with the current task',
		async () => {
			if (!bridgeRelay || !isAbsolute(bridgeRelay))
				throw new Error('Expected an absolute Slack bridge fixture path')

			const f = await fixture('none', false)
			const { directory, grant, route } = await standingGrant(f, bridgeRelay)
			const githubUrl = 'https://github.com/example/project/issues/42'
			await db
				.update(tasks)
				.set({ ticket_provider: 'github', ticket_url: githubUrl })
				.where(eq(tasks.id, f.taskId))
			try {
				await writeFile(route.providerConfigFile, JSON.stringify({ route }), { mode: 0o600 })
				await writeFile(grant, JSON.stringify(route), { mode: 0o600 })
				const followUpAt = Date.parse('2025-06-15T12:00:00Z')
				const due = {
					kind: 'external_wait' as const,
					reason: 'The example provider is checking campaign limits.',
					responsible: 'Example provider',
					nextAction: 'Confirm the original counting window.',
					evidence: 'Private fixture evidence.',
					followUpAt,
				}
				const { attention } = await f.set(due)
				await f.heartbeat()

				const notice = (await f.read()).task_attention!.notice!
				const ts = '1750000000.000001'
				expect(notice.slack).toMatchObject({
					status: 'delivered',
					receipt: `${route.teamId}/${route.channelId}/${ts}`,
				})
				const postedPath = route.providerConfigFile + '.posted'
				const posted = await readFile(postedPath, 'utf8')
				expect(JSON.parse(posted)).toMatchObject({
					channel: route.channelId,
					ts,
					text: expect.stringContaining(due.reason),
				})
				expect(posted).toContain(due.responsible)
				expect(posted).toContain(due.nextAction)
				expect(posted).toContain(githubUrl)
				expect(posted).toContain('Due · 2025-06-15 12:00 UTC')
				expect(posted).toContain(`${route.appOrigin}/tasks/${f.taskId}`)
				expect(posted).not.toContain(due.evidence)

				const retainedPost = postedPath + '.retained'
				await rename(postedPath, retainedPost)
				await f.heartbeat()
				expect((await f.read()).task_attention!.notice).toEqual(notice)
				await expect(readFile(postedPath)).rejects.toMatchObject({ code: 'ENOENT' })
				await rename(retainedPost, postedPath)

				const reason = 'The example provider changed the accounting period.'
				const nextAction = 'Request the revised counting window in writing.'
				await f.set({ ...due, reason, nextAction }, key(attention!))
				const { rows } = await call(
					syncTasksProcedure,
					{ where: { type: 'comparison', field: ['id'], operator: 'eq', value: f.taskId }, limit: 1 },
					f.api(),
				)
				const [task] = rows
				expect(task?.task_attention).toMatchObject({ reason, nextAction, notice })

				const request = JSON.stringify({ task, expectedNextAction: nextAction }, (_key, value) =>
					typeof value === 'bigint' ? value.toString() : value,
				)
				const reply = exec(process.execPath, [bridgeRelay, 'reply', route.providerConfigFile], {
					encoding: 'utf8',
					timeout: 15_000,
					maxBuffer: 4096,
					env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
				})
				reply.child.stdin?.on('error', () => undefined)
				reply.child.stdin?.end(request)
				const { stdout } = await reply
				expect(JSON.parse(stdout)).toEqual({
					nextAction,
					specialist: 'coder',
					sameThread: true,
					postedReplies: 2,
					duplicateRuns: 0,
				})
			} finally {
				vi.unstubAllEnvs()
				await rm(directory, { recursive: true, force: true })
			}
		},
		30_000,
	)
})

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { pullRequests } from '@humanlayer/db/tables/pull-requests'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { describeBoardTask } from '@humanlayer/schemas/task-board'
import type { AutomaticDelivery, DeliveryInspectionIssue } from '@humanlayer/schemas/zod/automatic-delivery'
import {
	formatPostgresDatabaseUrl,
	getExternalTestServicesConfig,
} from '@humanlayer/test-fixtures/external-test-services'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { lockDeliveryTask, type DeliveryTransaction } from '../../src/db/automatic-delivery'
import {
	completeImplementationInspection,
	readTaskReconciliation,
	reconcileImplementation,
} from '../../src/db/implementation-reconciliation'
import {
	catchUpImplementationTasks,
	reconcileImplementationTask,
	startImplementationReconciliation,
} from '../../src/lib/implementation-reconciliation-events'
import { configureDeliveryAlertsProcedure } from '../../src/orpc/api/tasks/delivery'
import { claimDeliveryProcedure, completeDeliveryProcedure } from '../../src/orpc/daemon/delivery'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb, type TestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('Implementation reconciliation', () => {
	let testDb: TestDb
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	const ownerId = 'implementation-reconciliation-owner'
	const organizationId = uuidv7()
	const projectId = uuidv7()
	const head = {
		repository: 'owner/repository',
		branch: 'feature',
		base: 'main',
		directory: '/repo/feature',
		number: 3,
		sha: '8'.repeat(40),
		merged: false,
		draft: false,
	}

	beforeAll(async () => {
		testDb = await createTestDb('implementation_reconciliation')
		const { db } = testDb
		runtime = createRuntimeWithTestPostgresLayer(db)
		await db
			.insert(organizations)
			.values({ id: organizationId, name: 'Reconciliation', workos_organization_id: uuidv7() })
		await db.insert(projects).values({
			id: projectId,
			name: 'Project',
			organization_id: organizationId,
			created_by: ownerId,
			resource_owner_user_id: ownerId,
			// A new project default must not enroll the existing fixture.
			delivery_mode: 'merge',
			repositories: [
				{
					remoteUrl: 'https://github.com/owner/repository.git',
					repositoryIdentity: 'github.com/owner/repository',
					defaultBranch: 'main',
					default: true,
					autoPushBranch: false,
					copyGlobs: [],
				},
			],
		})
	}, 30_000)
	afterAll(async () => testDb?.cleanup())

	async function fixture(
		options: {
			label?: 'rpi:implementation' | 'rpi:describe-pr'
			status?: typeof sessions.$inferSelect.status
			offline?: boolean
			untracked?: boolean
			off?: boolean
			age?: number
			autoPublish?: boolean
			draft?: boolean
			archived?: boolean
			projectId?: string
		} = {},
	) {
		const { db } = testDb
		const taskId = uuidv7()
		const hostId = uuidv7()
		const sessionId = uuidv7()
		const updated = BigInt(Date.now() - (options.age ?? 0))
		const label = options.label ?? 'rpi:implementation'
		const branch = `feature-${taskId}`
		const target = { ...head, branch }
		await db.insert(onlineHosts).values({
			organization_id: organizationId,
			user_id: ownerId,
			host_id: hostId,
			status: options.offline ? 'offline' : 'online',
			last_seen: BigInt(Date.now()),
		})
		await db.insert(tasks).values({
			id: taskId,
			name: 'Existing task',
			organization_id: organizationId,
			created_by: ownerId,
			resource_owner_user_id: ownerId,
			project_id: options.projectId ?? projectId,
			created_at: updated,
			updated_at: updated,
			is_draft: options.draft,
			archived: options.archived,
			auto_advance_implementation_to_pr: options.autoPublish,
			delivery_snapshot: options.off ? { mode: 'off', authorizedBy: ownerId, authorizedAt: Date.now() } : null,
		})
		await db.insert(sessions).values({
			id: sessionId,
			task_id: taskId,
			organization_id: organizationId,
			host_id: hostId,
			created_by: ownerId,
			resource_owner_user_id: ownerId,
			working_directory: head.directory,
			labels: [{ name: label, title: label.slice(4) }],
			status: options.status ?? 'ready_for_input',
			coding_agent: 'claude',
			provider: 'anthropic',
			model: 'opus',
			created_at: updated,
			updated_at: updated,
			last_activity_at: updated,
			next_step_suggestions: options.autoPublish
				? [
						{
							parsedAt: Date.now(),
							extraction: {
								type: 'next_step_found',
								nextStepPrompt: 'Use rpi:describe-pr',
								nextStepSummary: 'Publish the work',
								nextStepType: 'describe-pr',
								taskReference: taskId,
								suggestedDirectory: head.directory,
							},
						},
					]
				: undefined,
		})
		if (!options.untracked)
			await db.insert(sessionRepositories).values({
				organization_id: organizationId,
				task_id: taskId,
				session_id: sessionId,
				host_id: hostId,
				local_path: head.directory,
				repo_full_name: head.repository,
				branch,
			})
		const read = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
		const state = async () => readTaskReconciliation(await read())
		const history = () => db.select().from(sessions).where(eq(sessions.task_id, taskId))
		const board = async () => describeBoardTask(await read(), await history())
		const locked = <A>(fn: (tx: DeliveryTransaction, task: typeof tasks.$inferSelect) => Promise<A>) =>
			db.transaction(async (tx) => fn(tx, (await lockDeliveryTask(tx, taskId, organizationId))!))
		const plan = () => reconcileImplementationTask(db, runtime, { taskId, organizationId })
		const context = createMockDaemonContext({
			auth: createMockDaemonAuth({ organizationId, userId: ownerId, hostId }),
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		})
		const claim = () => call(claimDeliveryProcedure, {}, { context }).then((response) => response.action)
		const complete = (
			leaseId: string,
			changes?: {
				error: string
				inspectionIssue: DeliveryInspectionIssue
			},
		) =>
			call(
				completeDeliveryProcedure,
				changes
					? { taskId, leaseId, heads: [], ...changes }
					: { taskId, leaseId, heads: [target], error: null },
				{ context },
			)
		const setStatus = (status: typeof sessions.$inferSelect.status) =>
			db.update(sessions).set({ status }).where(eq(sessions.id, sessionId))
		return {
			taskId,
			sessionId,
			hostId,
			target,
			read,
			state,
			history,
			board,
			locked,
			plan,
			claim,
			complete,
			setStatus,
		}
	}

	it('uses a committed session event and existing daemon rather than a browser to verify a delivery-off task', async () => {
		const { db, databaseName } = testDb
		const f = await fixture({ status: 'running', off: true })
		const listener = postgres(formatPostgresDatabaseUrl(getExternalTestServicesConfig(), databaseName))
		const stop = await startImplementationReconciliation(db, runtime, listener.listen)
		try {
			await expect(
				db.transaction(async (tx) => {
					await tx.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.sessionId))
					throw new Error('fixture rollback')
				}),
			).rejects.toThrow('fixture rollback')
			expect((await f.state()).decision).toBeNull()
			await f.setStatus('ready_for_input')
			await expect.poll(async () => (await f.state()).decision?.status).toBe('verifying')
			const lease = (await f.claim())!
			expect(lease).toMatchObject({
				taskId: f.taskId,
				kind: 'inspect',
				targets: [{ repository: head.repository, branch: f.target.branch, directory: head.directory }],
			})
			expect(await f.complete(lease.leaseId)).toEqual({ accepted: true })
			expect(await f.board()).toMatchObject({
				columnId: 'in-review',
				status: 'ready_for_input',
				delivery: { status: 'blocked', alert: { slack: 'unavailable', origin: 'unavailable' } },
			})
			expect(await f.read()).toMatchObject({
				archived: false,
				automatic_delivery: null,
				delivery_snapshot: { mode: 'off' },
			})
			expect(await f.history()).toHaveLength(1)
		} finally {
			await stop()
			await listener.end()
		}
	})

	it('reconciles saved wait and heartbeat deadlines without another workflow event', async () => {
		const { db, databaseName } = testDb
		const live = await fixture({ status: 'running' })
		const queued = await fixture({ label: 'rpi:describe-pr', status: 'ready_for_launch', age: 30 * 60_000 - 1800 })
		await db
			.update(onlineHosts)
			.set({ last_seen: BigInt(Date.now() - 120_000 + 1800) })
			.where(eq(onlineHosts.host_id, live.hostId))
		const listener = postgres(formatPostgresDatabaseUrl(getExternalTestServicesConfig(), databaseName))
		const stop = await startImplementationReconciliation(db, runtime, listener.listen)
		try {
			await expect
				.poll(async () => (await queued.state()).decision?.status, { timeout: 1450 })
				.toBe('waiting-publication')
			expect(await queued.board()).toMatchObject({
				delivery: { status: 'queued', deadlineAt: expect.any(Number) },
			})
			await expect
				.poll(async () => (await queued.state()).decision, { timeout: 4000 })
				.toMatchObject({ status: 'blocked', reason: 'publication-unavailable' })
			await expect
				.poll(async () => (await live.state()).decision, { timeout: 4000 })
				.toMatchObject({ status: 'blocked', reason: 'writer-unknown' })
			expect((await live.board()).status).toBe('running')
			expect((await queued.board()).status).toBe('ready_for_launch')
			expect(await live.history()).toHaveLength(1)
			expect(await queued.history()).toHaveLength(1)
			await db
				.update(onlineHosts)
				.set({ last_seen: BigInt(Date.now()) })
				.where(eq(onlineHosts.host_id, live.hostId))
			await expect.poll(async () => (await live.state()).decision).toBeNull()
		} finally {
			await stop()
			await listener.end()
		}
	})

	it('clears decisions and wakes whose last session disappeared while the API observer was disconnected', async () => {
		const { db, databaseName } = testDb
		const live = await fixture({ status: 'running' })
		const blocked = await fixture({ untracked: true })
		await live.plan()
		await blocked.plan()
		expect((await live.state()).wakeAt).toEqual(expect.any(Number))
		expect((await blocked.state()).decision?.status).toBe('blocked')
		for (const f of [live, blocked]) await db.delete(sessions).where(eq(sessions.id, f.sessionId))
		const listener = postgres(formatPostgresDatabaseUrl(getExternalTestServicesConfig(), databaseName))
		const stop = await startImplementationReconciliation(db, runtime, listener.listen)
		try {
			await expect.poll(async () => (await live.state()).wakeAt).toBeUndefined()
			await expect.poll(async () => (await blocked.state()).decision).toBeNull()
		} finally {
			await stop()
			await listener.end()
		}
	})

	it('catches up old and recent unenrolled cards without age-driven decisions or fake review placement', async () => {
		const old = await fixture({ label: 'rpi:describe-pr', age: 10 * 24 * 60 * 60_000, untracked: true })
		const recent = await fixture({ untracked: true })
		const archived = await fixture({ archived: true, untracked: true })
		const draft = await fixture({ draft: true, untracked: true })
		const active = await fixture({ status: 'running', untracked: true })
		const updatedAt = (await old.read()).updated_at
		await catchUpImplementationTasks(testDb.db, runtime)
		for (const f of [recent, old]) {
			expect((await f.state()).decision).toEqual({
				status: 'blocked',
				reason: 'workspace-required',
				stage: 'implementation',
			})
			expect((await f.board()).columnId).toBe('implementation')
			expect((await f.read()).automatic_delivery).toBeNull()
			expect(await f.history()).toHaveLength(1)
		}
		expect((await old.read()).updated_at).toBe(updatedAt)
		for (const f of [archived, draft]) expect((await f.read()).implementation_reconciliation).toBeNull()
		expect((await active.state()).decision).toBeNull()
		expect((await active.board()).status).toBe('running')
	})

	it('shows the same blocker and native receipt across replays, and replaces a materially different blocker', async () => {
		const { db } = testDb
		const f = await fixture({ offline: true, untracked: true })
		const opts = {
			context: createMockApiContext({
				auth: createMockApiAuth({ organizationId, userId: ownerId }),
				services: { db, dbReadReplica: db, effectRuntime: runtime },
			}),
		}
		await call(
			configureDeliveryAlertsProcedure,
			{
				taskId: f.taskId,
				routes: { origin: { kind: 'session', sessionId: f.sessionId } },
			},
			opts,
		)
		await f.plan()
		const first = (await f.state()).blockerAlert
		expect(first).toMatchObject({ slack: { status: 'unavailable' }, origin: { status: 'delivered' } })
		await db.update(tasks).set({ name: 'Edited passive title' }).where(eq(tasks.id, f.taskId))
		await f.plan()
		expect((await f.state()).blockerAlert).toEqual(first)
		await db.update(onlineHosts).set({ status: 'online' }).where(eq(onlineHosts.host_id, f.hostId))
		await f.plan()
		expect((await f.state()).decision).toMatchObject({ status: 'blocked', reason: 'workspace-required' })
		expect((await f.state()).blockerAlert?.id).not.toBe(first?.id)
		const messages = await db
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.session_id, f.sessionId))
		expect(messages.filter((event) => event.content?.includes('delivery_blocker'))).toHaveLength(2)
	})

	it('catches up legacy blockers through a standing private Slack route without replaying receipts', async () => {
		const { db } = testDb
		const standingProjectId = uuidv7()
		const routeId = uuidv7()
		const appOrigin = 'http://127.0.0.1:51969'
		await db.insert(projects).values({
			id: standingProjectId,
			name: 'Standing route fixture',
			organization_id: organizationId,
			created_by: ownerId,
			resource_owner_user_id: ownerId,
			repositories: [],
		})
		const eligible = { projectId: standingProjectId, off: true, untracked: true }
		const legacy = await fixture(eligible)
		const optedOut = await fixture(eligible)
		const muted = await fixture(eligible)
		const archived = await fixture({ ...eligible, archived: true })
		const excluded = await fixture({ off: true, untracked: true })
		await db.update(tasks).set({ slack_notifications_muted: true }).where(eq(tasks.id, muted.taskId))
		const opts = {
			context: createMockApiContext({
				auth: createMockApiAuth({ organizationId, userId: ownerId }),
				services: { db, dbReadReplica: db, effectRuntime: runtime },
			}),
		}
		const directory = mkdtempSync(join(tmpdir(), 'standing-slack-catch-up-'))
		const grant = join(directory, 'local-grant.json')
		const script = join(directory, 'fake-provider.mjs')
		const requests = join(directory, 'requests.jsonl')
		try {
			vi.stubEnv('APP_ORIGIN', appOrigin)
			vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', grant)
			await call(
				configureDeliveryAlertsProcedure,
				{ taskId: legacy.taskId, routes: { origin: { kind: 'session', sessionId: legacy.sessionId } } },
				opts,
			)
			await call(
				configureDeliveryAlertsProcedure,
				{ taskId: legacy.taskId, routes: { slackMode: 'inherit' } },
				opts,
			)
			await call(
				configureDeliveryAlertsProcedure,
				{ taskId: optedOut.taskId, routes: { slackMode: 'off' } },
				opts,
			)
			await catchUpImplementationTasks(db, runtime)
			const first = (await legacy.state()).blockerAlert
			expect(first).toMatchObject({
				id: expect.any(String),
				slack: { status: 'unavailable' },
				origin: { status: 'delivered', receipt: expect.any(String) },
			})
			expect(existsSync(requests)).toBe(false)

			writeFileSync(
				script,
				[
					"import { appendFileSync, readFileSync } from 'node:fs';",
					"const message = JSON.parse(readFileSync(0, 'utf8'));",
					"appendFileSync(process.argv[2], JSON.stringify(message) + '\\n');",
					'const { schemaVersion, routeId, projectId, taskId, alertId, teamId, channelId, botUserId } = message;',
					"console.log(JSON.stringify({ status: 'delivered', schemaVersion, routeId, projectId, taskId, alertId, teamId, channelId, botUserId, messageTs: '1710000000.000001' }));",
				].join('\n'),
			)
			writeFileSync(
				grant,
				JSON.stringify({
					schemaVersion: 2,
					routeId,
					organizationId,
					ownerId,
					projectIds: [standingProjectId],
					appOrigin,
					teamId: 'TFIXTURE',
					channelId: 'DFIXTURE',
					botUserId: 'UBOT',
					recipientUserId: 'URECIPIENT',
					executable: process.execPath,
					script,
					providerConfigFile: requests,
				}),
				{ mode: 0o600 },
			)
			const ordinary = await fixture(eligible)
			await catchUpImplementationTasks(db, runtime)
			const settled = (await legacy.state()).blockerAlert
			expect(settled).toMatchObject({
				id: first?.id,
				slackRoute: 'standing',
				slack: { status: 'delivered', receipt: 'TFIXTURE/DFIXTURE/1710000000.000001' },
				origin: first?.origin,
			})
			expect(await legacy.board()).toMatchObject({
				delivery: {
					status: 'blocked',
					alert: { slack: 'delivered', origin: 'delivered', slackRoute: 'standing' },
				},
			})
			expect((await ordinary.state()).blockerAlert).toMatchObject({
				slackRoute: 'standing',
				slack: { status: 'delivered' },
				origin: { status: 'unavailable' },
			})
			for (const task of [legacy, ordinary])
				expect(await task.read()).toMatchObject({
					automatic_delivery: null,
					delivery_snapshot: { mode: 'off' },
				})
			for (const task of [optedOut, muted])
				expect((await task.state()).blockerAlert).toMatchObject({
					slackRoute: 'off',
					slack: { status: 'unavailable' },
				})
			expect((await excluded.state()).blockerAlert).toMatchObject({
				slackRoute: 'unavailable',
				slack: { status: 'unavailable' },
			})
			expect((await archived.read()).implementation_reconciliation).toBeNull()
			await catchUpImplementationTasks(db, runtime)
			expect((await legacy.state()).blockerAlert).toEqual(settled)
			const posts = readFileSync(requests, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
			expect(posts).toMatchObject([
				{
					schemaVersion: 2,
					routeId,
					projectId: standingProjectId,
					taskId: legacy.taskId,
					alertId: first?.id,
					taskLabel: 'Existing task',
					blocker: 'workspace-required',
				},
				{ taskId: ordinary.taskId, alertId: (await ordinary.state()).blockerAlert?.id },
			])
			const events = await db
				.select()
				.from(conversationEvents)
				.where(eq(conversationEvents.session_id, legacy.sessionId))
			expect(events.filter((event) => event.content?.includes('delivery_blocker'))).toHaveLength(1)
		} finally {
			vi.unstubAllEnvs()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it('serializes a non-mutating inspection, allows one expiry retry, and fences late responses and changed scope', async () => {
		const { db } = testDb
		const f = await fixture()
		await f.plan()
		const claimed = await Promise.all([f.claim(), f.claim()])
		const first = claimed.find(Boolean)!
		expect(claimed.filter(Boolean)).toHaveLength(1)
		const expiry = (await f.state()).lease!.expiresAt
		await db
			.update(onlineHosts)
			.set({ last_seen: BigInt(expiry) })
			.where(eq(onlineHosts.host_id, f.hostId))
		const second = (await f.locked((tx, row) =>
			reconcileImplementation(tx, row, { hostId: f.hostId, now: expiry }),
		))!
		expect(second?.leaseId).not.toBe(first.leaseId)
		expect(await f.complete(first.leaseId)).toEqual({ accepted: false })
		await db.update(tasks).set({ ticket_description: 'New scope' }).where(eq(tasks.id, f.taskId))
		expect(await f.complete(second.leaseId)).toEqual({ accepted: false })
		expect((await f.state()).heads).toBeUndefined()
		expect(await f.history()).toHaveLength(1)
	})

	it('honors a queued writer and revoked publication authority under the same task lock', async () => {
		const { db } = testDb
		const f = await fixture({ autoPublish: true })
		await f.plan()
		const first = (await f.claim())!
		await db.insert(queuedMessages).values({
			organization_id: organizationId,
			resource_owner_user_id: ownerId,
			user_id: ownerId,
			session_id: f.sessionId,
			task_id: f.taskId,
			content: 'Continue with my instructions',
		})
		expect(await f.complete(first.leaseId)).toEqual({ accepted: false })
		expect(await f.history()).toHaveLength(1)
		await db.update(queuedMessages).set({ status: 'delivered' }).where(eq(queuedMessages.task_id, f.taskId))
		await f.plan()
		const second = (await f.claim())!
		await db.update(tasks).set({ auto_advance_implementation_to_pr: false }).where(eq(tasks.id, f.taskId))
		expect(await f.complete(second.leaseId, { error: 'Missing', inspectionIssue: 'pr-missing' })).toEqual({
			accepted: false,
		})
		await f.plan()
		const final = (await f.claim())!
		expect(await f.complete(final.leaseId, { error: 'Missing', inspectionIssue: 'pr-missing' })).toEqual({
			accepted: true,
		})
		expect((await f.state()).decision).toMatchObject({ reason: 'pr-missing' })
		expect(await f.history()).toHaveLength(1)
	})

	it('recovers an authorized missed stock publication once through the existing Describe PR admission', async () => {
		const f = await fixture({ autoPublish: true })
		await f.plan()
		const action = (await f.claim())!
		expect(await f.complete(action.leaseId, { error: 'Missing', inspectionIssue: 'pr-missing' })).toEqual({
			accepted: true,
		})
		await Promise.all([f.plan(), f.plan()])
		expect(await f.history()).toHaveLength(2)
		expect(await f.board()).toMatchObject({ columnId: 'implementation', delivery: { status: 'queued' } })
		expect((await f.read()).automatic_delivery).toBeNull()
	})

	it('rejects conflicting heads and preserves independently reviewed exact merged evidence until a new head is seen', async () => {
		const { db } = testDb
		const conflicting = await fixture()
		await conflicting.plan()
		const wrong = (await conflicting.claim())!
		expect(
			await conflicting.complete(wrong.leaseId, { error: 'Mismatch', inspectionIssue: 'pr-head-mismatch' }),
		).toEqual({ accepted: true })
		expect((await conflicting.state()).decision).toMatchObject({ reason: 'head-mismatch' })
		expect((await conflicting.board()).columnId).toBe('implementation')

		const reviewed = await fixture({ off: true })
		const verified = { ...reviewed.target, merged: true }
		const delivery: AutomaticDelivery = {
			version: 1,
			authorizedBy: ownerId,
			authorizedAt: Date.now(),
			mode: 'archive-only',
			hostId: reviewed.hostId,
			sourceSessionId: reviewed.sessionId,
			targets: [reviewed.target],
			policyAcknowledgement: 'Read-only verification',
			phase: 'disabled',
			passes: 1,
			recoveryAttempts: 0,
			managedSessionId: null,
			managedAt: 0,
			deliverySessionIds: [],
			workRevision: '',
			heads: [verified],
			attention: null,
			lease: null,
			reviews: [
				{
					sessionId: uuidv7(),
					source: 'local-qa',
					verdict: 'clean',
					automaticMergeAllowed: false,
					humanCheckpointsSatisfied: true,
					heads: [verified],
					findings: [],
					evidence: 'Verified',
				},
			],
		}
		await db.update(tasks).set({ automatic_delivery: delivery }).where(eq(tasks.id, reviewed.taskId))
		await reviewed.plan()
		const check = (await reviewed.claim())!
		await reviewed.locked((tx, row) =>
			completeImplementationInspection(tx, row, {
				hostId: reviewed.hostId,
				leaseId: check.leaseId,
				heads: [verified],
				error: null,
			}),
		)
		expect(await reviewed.board()).toMatchObject({ columnId: 'in-review', delivery: { status: 'review' } })
		expect((await reviewed.read()).archived).toBe(false)
		await db.insert(pullRequests).values({
			organization_id: organizationId,
			task_id: reviewed.taskId,
			repo_full_name: head.repository,
			number: head.number,
			url: 'https://github.com/owner/repository/pull/3',
			title: 'New revision',
			head_ref: reviewed.target.branch,
			base_ref: head.base,
			head_sha: 'a'.repeat(40),
			state: 'open',
		})
		await reviewed.plan()
		expect((await reviewed.state()).decision).toMatchObject({ status: 'verifying' })
		expect((await reviewed.state()).heads).toBeUndefined()
	})
})

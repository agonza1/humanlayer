import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, it } from '@effect/vitest'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { slackIntegrations } from '@humanlayer/db/tables/slack-integrations'
import { slackNotificationAutomations } from '@humanlayer/db/tables/slack-notification-automations'
import { slackNotificationThreads } from '@humanlayer/db/tables/slack-notification-threads'
import { tasks } from '@humanlayer/db/tables/tasks'
import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import { describeBoardTask } from '@humanlayer/schemas/task-board'
import {
	decodeDelivery,
	DELIVERY_DIAGNOSIS_LABEL,
	DELIVERY_DIAGNOSIS_MODEL,
	type DeliveryAlertReceipt,
	type DeliveryAlertRoutesInputSchema,
	type AutomaticDelivery,
	type DeliveryCommit,
	type DeliveryHead,
	type DeliveryReview,
} from '@humanlayer/schemas/zod/automatic-delivery'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer } from 'effect'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import type { z } from 'zod/v4'

import {
	acceptDeliveryReview,
	claimTaskDelivery,
	completeTaskDelivery,
	lockDeliveryTask,
} from '../../src/db/automatic-delivery'
import {
	finishSlackBlockerDispatch,
	reserveDeliveryBlockerAlerts,
	validateSlackBlockerDispatch,
} from '../../src/db/delivery-blocker-alerts'
import { guardTaskDeliveryMutation } from '../../src/db/guard-delivery-mutation'
import { SlackService } from '../../src/effects/services/slack/slack.service'
import {
	acknowledgeDeliveryBlockerProcedure,
	configureDeliveryAlertsProcedure,
} from '../../src/orpc/api/tasks/delivery'
import { upsertArtifactProcedure } from '../../src/orpc/daemon/artifacts/upsert'
import {
	claimDeliveryProcedure,
	completeDeliveryProcedure,
	validateDeliveryProcedure,
} from '../../src/orpc/daemon/delivery'
import { shutdownEffectProcedure } from '../../src/orpc/daemon/hosts/shutdown.effect'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import {
	bindProcedureToRuntime,
	createRuntimeWithTestPostgresLayer,
	fakeSlackLayer,
} from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()
const exec = promisify(execFile)

describe('Persisted automatic delivery', () => {
	let db: PostgresJsDatabase
	let cleanup: () => Promise<void>
	let organizationId: string
	const hostId = uuidv7()
	const target = { repository: 'test/delivery', branch: 'feature', base: 'main', directory: '/tmp/delivery' }
	const head = { ...target, number: 12, sha: 'a'.repeat(40), merged: false }
	beforeAll(async () => {
		const testDb = await createTestDb('automatic_delivery')
		db = testDb.db
		cleanup = testDb.cleanup
		const [org] = await db
			.insert(organizations)
			.values({ name: 'Delivery test', workos_organization_id: uuidv7() })
			.returning()
		organizationId = org!.id
	}, 30000)
	afterAll(async () => cleanup?.())

	async function fixture(mode: AutomaticDelivery['mode'] = 'merge', assignedHost = hostId, workspace = target) {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: 'Deliver',
				created_by: 'owner',
				resource_owner_user_id: 'owner',
			})
			.returning()
		const [source] = await db
			.insert(sessions)
			.values({
				organization_id: organizationId,
				task_id: task!.id,
				created_by: 'owner',
				resource_owner_user_id: 'owner',
				host_id: assignedHost,
				working_directory: workspace.directory,
				status: 'ready_for_input',
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'opus',
			})
			.returning()
		await db.insert(sessionRepositories).values({
			organization_id: organizationId,
			task_id: task!.id,
			session_id: source!.id,
			host_id: assignedHost,
			local_path: workspace.directory,
			repo_full_name: workspace.repository,
			branch: workspace.branch,
		})
		const delivery: AutomaticDelivery = {
			version: 1,
			authorizedBy: 'owner',
			authorizedAt: Date.now(),
			mode,
			hostId: assignedHost,
			sourceSessionId: source!.id,
			targets: [workspace],
			policyAcknowledgement: 'Repository permits this task',
			phase: 'implementation',
			passes: 0,
			recoveryAttempts: 0,
			managedSessionId: null,
			managedAt: Date.now(),
			deliverySessionIds: [],
			workRevision: '',
			heads: [],
			reviews: [],
			attention: null,
			lease: null,
		}
		await db.update(tasks).set({ automatic_delivery: delivery }).where(eq(tasks.id, task!.id))
		const taskId = task!.id
		const locked = <A>(
			fn: (tx: Parameters<typeof claimTaskDelivery>[0], row: typeof tasks.$inferSelect) => Promise<A>,
		) => db.transaction(async (tx) => fn(tx, (await lockDeliveryTask(tx, taskId, organizationId))!))
		const claim = (supportsObservation = false) =>
			locked((tx, row) => claimTaskDelivery(tx, row, supportsObservation))
		const state = async () => {
			const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
			return decodeDelivery(row!.automatic_delivery)!
		}
		const idle = async () => {
			const current = await state()
			if (current.managedSessionId)
				await db
					.update(sessions)
					.set({ status: 'ready_for_input' })
					.where(eq(sessions.id, current.managedSessionId))
		}
		const complete = (leaseId: string, heads = [head], error: string | null = null) =>
			locked((tx, row) => completeTaskDelivery(tx, row, leaseId, heads, error))
		const reachReview = async () => {
			await claim()
			await idle()
			const action = await claim()
			expect(action?.kind).toBe('inspect')
			await complete(action!.leaseId)
			return state()
		}
		const review = async (patch: Partial<DeliveryReview> = {}) => {
			const current = await state()
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, current.managedSessionId!))
			return locked((tx, row) =>
				acceptDeliveryReview(tx, row, {
					sessionId: current.managedSessionId!,
					source: 'local-qa',
					verdict: 'clean',
					automaticMergeAllowed: true,
					humanCheckpointsSatisfied: true,
					heads: current.heads,
					findings: [],
					evidence: 'Independent complete-diff QA and tests at exact head',
					...patch,
				}),
			)
		}
		return { taskId, source: source!, locked, claim, state, idle, complete, reachReview, review }
	}

	it('recovers an unreported commit across host restarts, repairs on the same branch and reaches the merge gate', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'delivery-exit-'))
		try {
			const workspace = { ...target, directory }
			const remote = join(directory, '..', `${directory.split('/').at(-1)}.git`)
			const git = async (...args: string[]) => (await exec('git', args, { cwd: directory })).stdout.trim()
			await git('init', '--bare', remote)
			try {
				await git('init', '-b', 'main')
				await git('config', 'user.name', 'Delivery Fixture')
				await git('config', 'user.email', 'fixture@example.invalid')
				await writeFile(join(directory, 'answer.txt'), 'original\n')
				await git('add', 'answer.txt')
				await git('commit', '-m', 'Base')
				const baseSha = await git('rev-parse', 'HEAD')
				await git('remote', 'add', 'origin', remote)
				await git('push', 'origin', 'main')
				await git('switch', '-c', target.branch)
				const f = await fixture('merge', uuidv7(), workspace)
				await db
					.update(sessions)
					.set({
						status: 'running',
						coding_agent: 'codelayer',
						provider: 'codex',
						model: 'gpt-5.4',
					})
					.where(eq(sessions.id, f.source.id))
				// A fixture worker leaves a real local commit and exits before any completion message.
				await expect(
					exec(
						'/bin/sh',
						['-ec', "printf 'wrong\\n' > answer.txt; git commit -am 'Implement answer'; exit 42"],
						{
							cwd: directory,
						},
					),
				).rejects.toMatchObject({ code: 42 })
				const originalSha = await git('rev-parse', 'HEAD')
				expect(await git('ls-remote', 'origin', 'refs/heads/feature')).toBe('')
				await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, f.source.id))

				const hostId = f.source.host_id!
				const effectRuntime = createRuntimeWithTestPostgresLayer(db)
				const context = createMockDaemonContext({
					auth: createMockDaemonAuth({ organizationId, userId: 'owner', hostId }),
					services: { db, dbReadReplica: db, effectRuntime },
				})
				const shutdown = bindProcedureToRuntime(shutdownEffectProcedure, effectRuntime)
				const claim = () => call(claimDeliveryProcedure, {}, { context }).then(({ action }) => action)
				const complete = (
					action: DeliveryAction,
					evidence: { heads: DeliveryHead[]; recoveredCommits?: DeliveryCommit[] },
				) =>
					call(
						completeDeliveryProcedure,
						{ taskId: f.taskId, leaseId: action.leaseId, error: null, ...evidence },
						{ context },
					)
				const validate = (action: DeliveryAction) =>
					call(validateDeliveryProcedure, { taskId: f.taskId, leaseId: action.leaseId }, { context })
				const expireLease = async () => {
					const persisted = await f.state()
					await db
						.update(tasks)
						.set({
							automatic_delivery: { ...persisted, lease: { ...persisted.lease!, expiresAt: 0 } },
						})
						.where(eq(tasks.id, f.taskId))
				}
				const history = () => db.select().from(sessions).where(eq(sessions.task_id, f.taskId))
				const worker = async () => {
					const { managedSessionId } = await f.state()
					return (await history()).find(({ id }) => id === managedSessionId)
				}
				const prs: Array<Omit<typeof head, 'sha'>> = []
				const adapter = resolve(
					import.meta.dirname,
					'../../../riptide-daemon/src/lib/github/automatic-delivery.ts',
				)
				const hostProcess = async (action: DeliveryAction, discardReply = false) => {
					const { stdout } = await exec(
						'bun',
						[
							'--no-env-file',
							'-e',
							`
						import { execFileSync } from 'node:child_process'
						import { executeDeliveryAction, inspectCommittedImplementation } from ${JSON.stringify(adapter)}
						const [action, prs, discardReply] = process.argv.slice(1).map(value => JSON.parse(value))
						const commands = {
							run: async (binary, args, cwd) => {
								if (binary === 'git' && args[0] === 'remote') return 'https://github.com/test/delivery.git'
								if (binary === 'git') return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
								if (args[0] !== 'pr' || args[1] !== 'list') throw Error('Unexpected GitHub mutation')
								return JSON.stringify(prs.map(pr => ({
									number: pr.number,
									headRefOid: execFileSync('git', ['rev-parse', 'refs/remotes/origin/' + pr.branch], { cwd, encoding: 'utf8' }).trim(),
									headRefName: pr.branch, baseRefName: pr.base, state: 'OPEN',
									isDraft: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [],
								})))
							},
						}
						const evidence = action.kind === 'recover'
							? { heads: [], recoveredCommits: await inspectCommittedImplementation(action.targets, commands) }
							: { heads: await executeDeliveryAction(action, commands, async () => { throw Error('Unexpected merge') }) }
						if (discardReply) process.exit(43)
						console.log(JSON.stringify(evidence))
					`,
							JSON.stringify(action),
							JSON.stringify(prs),
							JSON.stringify(discardReply),
						],
						{ cwd: directory },
					)
					return JSON.parse(stdout) as { heads: DeliveryHead[]; recoveredCommits?: DeliveryCommit[] }
				}

				const abandoned = (await claim())!
				expect(abandoned?.kind).toBe('recover')
				expect(await validate(abandoned)).toEqual({ authorized: false })
				await expect(hostProcess(abandoned, true)).rejects.toMatchObject({ code: 43 })
				expect(await claim()).toBeNull()
				await expireLease()
				expect(await complete(abandoned, { heads: [] })).toEqual({ accepted: false })
				const [first, second] = await Promise.all([claim(), claim()])
				const recovered = (first ?? second)!
				expect([first, second].filter(Boolean)).toHaveLength(1)
				const proof = await hostProcess(recovered)
				expect(proof.recoveredCommits).toEqual([{ ...workspace, sha: originalSha }])
				expect(await complete(abandoned, proof)).toEqual({ accepted: false })
				expect(await complete(recovered, proof)).toEqual({ accepted: true })
				expect(await complete(recovered, proof)).toEqual({ accepted: false })
				expect(await worker()).toMatchObject({
					title: expect.stringMatching(/^delivery pr:/),
					working_directory: directory,
					prompt: expect.stringContaining(originalSha),
				})
				expect(await claim()).toBeNull()
				expect(await history()).toHaveLength(2)
				await git('push', '-u', 'origin', target.branch)
				prs.push({ ...workspace, number: head.number, merged: false })
				await f.idle()
				const firstInspect = (await claim())!
				expect(await complete(firstInspect, await hostProcess(firstInspect))).toEqual({ accepted: true })
				expect(await f.state()).toMatchObject({ phase: 'review', passes: 1, heads: [{ sha: originalSha }] })
				expect(await worker()).toMatchObject({ prompt: expect.stringContaining(originalSha) })
				expect(await git('show', `${originalSha}:answer.txt`)).toBe('wrong')
				expect(
					await f.review({
						verdict: 'repair',
						findings: [
							{
								priority: 'P1',
								verified: true,
								related: true,
								detail: 'answer.txt must contain correct',
							},
						],
					}),
				).toBe(true)
				expect(await call(shutdown, { hostId }, { context })).toMatchObject({ sessionsUpdated: 1 })
				expect((await worker())?.status).toBe('failed')
				await claim()
				const repair = await worker()
				expect(repair).toMatchObject({
					title: expect.stringMatching(/^delivery repair:/),
					coding_agent: 'codelayer',
					provider: 'codex',
					working_directory: directory,
					prompt: expect.stringContaining('answer.txt must contain correct'),
				})
				expect(repair?.prompt).toContain(originalSha)
				await Promise.all([claim(), claim()])
				expect((await f.state()).managedSessionId).toBe(repair?.id)
				expect(await history()).toHaveLength(4)
				await writeFile(join(directory, 'answer.txt'), 'correct\n')
				await git('commit', '-am', 'Repair answer')
				await git('push', 'origin', target.branch)
				const repairedSha = await git('rev-parse', 'HEAD')
				expect(await git('rev-parse', 'HEAD^')).toBe(originalSha)
				await f.idle()
				const interruptedInspect = (await claim())!
				await expect(hostProcess(interruptedInspect, true)).rejects.toMatchObject({ code: 43 })
				expect(await f.state()).toMatchObject({ passes: 1, managedSessionId: null })
				await expireLease()
				const secondInspect = (await claim())!
				expect(secondInspect.leaseId).not.toBe(interruptedInspect.leaseId)
				expect(await complete(secondInspect, await hostProcess(secondInspect))).toEqual({ accepted: true })
				expect(await f.state()).toMatchObject({ phase: 'review', passes: 2, heads: [{ sha: repairedSha }] })
				expect(await worker()).toMatchObject({ prompt: expect.stringContaining(repairedSha) })
				expect(
					await f.review({ heads: [{ ...workspace, number: head.number, sha: originalSha, merged: false }] }),
				).toBe(false)
				expect(await git('show', `${repairedSha}:answer.txt`)).toBe('correct')
				expect(await f.review()).toBe(true)
				await f.idle()
				const finalInspect = (await claim())!
				expect(await complete(finalInspect, await hostProcess(finalInspect))).toEqual({ accepted: true })
				const merge = (await claim())!
				expect(merge).toMatchObject({ kind: 'merge', heads: [{ sha: repairedSha, number: head.number }] })
				expect(await validate(merge)).toEqual({ authorized: true })
				expect(await claim()).toBeNull()
				const final = await f.state()
				expect(final).toMatchObject({ passes: 2, recoveryAttempts: 0 })
				expect(final.reviews.map((review) => review.heads[0]?.sha)).toEqual([originalSha, repairedSha])
				expect(await history()).toHaveLength(5)
				expect(prs).toHaveLength(1)
				expect(await git('ls-remote', '--heads', 'origin')).toBe(
					`${repairedSha}\trefs/heads/feature\n${baseSha}\trefs/heads/main`,
				)
				console.info(
					JSON.stringify({
						originalSha,
						repairedSha,
						baseSha,
						pr: head.number,
						passes: final.passes,
						workers: final.deliverySessionIds,
						recoveryAttempts: final.recoveryAttempts,
						mergeAuthorized: true,
					}),
				)
			} finally {
				await rm(remote, { recursive: true, force: true })
			}
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}, 30_000)

	const confirmed = { status: 'delivered', receipt: 'T_TEST/C_TEST/1710000000.000002' } as const

	async function alertFixture(send: () => Promise<DeliveryAlertReceipt> = async () => confirmed) {
		const hostId = uuidv7()
		const f = await fixture('pr-only', hostId)
		await db
			.insert(organizationSettings)
			.values({
				organization_id: organizationId,
				slack_integration_enabled: true,
			})
			.onConflictDoUpdate({
				target: organizationSettings.organization_id,
				set: { slack_integration_enabled: true },
			})
		await db
			.insert(slackIntegrations)
			.values({
				organization_id: organizationId,
				slack_team_id: 'T_TEST',
				bot_access_token: 'test-only',
				bot_user_id: 'B_TEST',
				scopes: 'chat:write',
				connected_by_user_id: 'owner',
			})
			.onConflictDoNothing()
		const [automation] = await db
			.insert(slackNotificationAutomations)
			.values({
				name: 'Test blocker routing',
				organization_id: organizationId,
				channel_id: 'C_TEST',
				event_types: ['comment'],
				created_by_user_id: 'owner',
			})
			.returning()
		const sends: Array<{ channelId: string; threadTs?: string }> = []
		const slack = Layer.effect(
			SlackService,
			Effect.gen(function* () {
				const service = yield* SlackService
				return {
					...service,
					sendDeliveryBlocker: (input: Parameters<typeof service.sendDeliveryBlocker>[0]) =>
						Effect.promise(() => {
							sends.push(input)
							return send()
						}),
				}
			}),
		).pipe(Layer.provide(fakeSlackLayer))
		const runtime = createRuntimeWithTestPostgresLayer(db, { slack })
		const context = createMockDaemonContext({
			auth: createMockDaemonAuth({ organizationId, userId: 'owner', hostId }),
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		})
		const configure = (routes: z.infer<typeof DeliveryAlertRoutesInputSchema>, userId = 'owner') =>
			call(
				configureDeliveryAlertsProcedure,
				{ taskId: f.taskId, routes },
				{
					context: createMockApiContext({
						auth: createMockApiAuth({ organizationId, userId }),
						services: { db, dbReadReplica: db },
					}),
				},
			)
		const origin = { kind: 'session' as const, sessionId: f.source.id }
		const slackAutomationId = automation!.id
		const heartbeat = (supportsObservation = false) =>
			call(claimDeliveryProcedure, supportsObservation ? { supportsObservation: true } : {}, { context })
		const completeObservedMerge = (leaseId: string) =>
			call(
				completeDeliveryProcedure,
				{
					taskId: f.taskId,
					leaseId,
					heads: [{ ...head, merged: true, draft: false }],
					error: null,
				},
				{ context },
			)
		const block = () => db.update(sessions).set({ status: 'interrupted' }).where(eq(sessions.id, f.source.id))
		const notices = async () =>
			(await db.select().from(conversationEvents).where(eq(conversationEvents.session_id, f.source.id))).filter(
				(event) => event.event_type === 'system' && event.content?.includes('delivery_blocker'),
			)
		const thread = async () => {
			await db.insert(slackNotificationThreads).values({
				automation_id: slackAutomationId,
				task_id: f.taskId,
				organization_id: organizationId,
				channel_id: 'C_TEST',
				root_thread_ts: '1710000000.000001',
				status: 'ready',
			})
			return { kind: 'slack' as const, automationId: slackAutomationId }
		}
		return {
			...f,
			configure,
			block,
			heartbeat,
			completeObservedMerge,
			notices,
			origin,
			slackAutomationId,
			sends,
			thread,
		}
	}

	it('reconciles an existing managed blocker and fences a grant revoked before dispatch', async () => {
		const f = await fixture()
		const [project] = await db
			.insert(projects)
			.values({
				name: 'Personal delivery',
				organization_id: organizationId,
				created_by: 'owner',
				resource_owner_user_id: 'owner',
				repositories: [],
			})
			.returning()
		await db
			.update(tasks)
			.set({
				project_id: project!.id,
				automatic_delivery: { ...(await f.state()), phase: 'attention', attention: 'Private diagnostic' },
			})
			.where(eq(tasks.id, f.taskId))
		const dir = await mkdtemp(join(tmpdir(), 'standing-managed-slack-'))
		const grant = join(dir, 'route.json')
		const appOrigin = 'http://127.0.0.1:5175'
		const route = {
			schemaVersion: 2,
			routeId: uuidv7(),
			organizationId,
			ownerId: 'owner',
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
			expect(await f.locked(reserveDeliveryBlockerAlerts)).toEqual([])
			const before = (await f.state()).blockerAlert!
			expect(before.slack).toEqual({ status: 'unavailable' })

			await writeFile(grant, JSON.stringify(route), { mode: 0o600 })
			const [dispatch] = await f.locked(reserveDeliveryBlockerAlerts)
			expect(dispatch).toMatchObject({
				taskId: f.taskId,
				alertId: before.id,
				relayRouteId: route.routeId,
				standing: { projectId: project!.id, taskLabel: 'Deliver' },
				slots: ['slack'],
			})
			expect(await f.locked((tx) => validateSlackBlockerDispatch(tx, dispatch!))).toEqual({ slots: ['slack'] })

			await rm(grant)
			expect(await f.locked((tx) => validateSlackBlockerDispatch(tx, dispatch!))).toEqual({ slots: [] })
			await f.locked((tx) => finishSlackBlockerDispatch(tx, dispatch!, { kind: 'preflight', canceled: true }))
			await writeFile(grant, JSON.stringify({ ...route, routeId: uuidv7() }), { mode: 0o600 })
			const [retry] = await f.locked(reserveDeliveryBlockerAlerts)
			expect(retry).toMatchObject({ alertId: before.id, slots: ['slack'] })
			await f.locked((tx) =>
				finishSlackBlockerDispatch(tx, retry!, { kind: 'provider', result: { status: 'unknown' } }),
			)

			await writeFile(grant, JSON.stringify({ ...route, routeId: uuidv7() }), { mode: 0o600 })
			expect(await f.locked(reserveDeliveryBlockerAlerts)).toEqual([])
			expect((await f.state()).blockerAlert).toMatchObject({
				id: before.id,
				slackRoute: 'standing',
				slack: { status: 'unknown' },
			})
		} finally {
			vi.unstubAllEnvs()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('confirms both authorized routes independently and does not repost on heartbeat replay', async () => {
		const f = await alertFixture()
		await expect(
			f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin }, 'non-owner'),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await f.block()
		await f.heartbeat()
		await f.heartbeat()
		const [notice] = await f.notices()
		expect(await f.notices()).toHaveLength(1)
		expect((await f.state()).blockerAlert).toMatchObject({
			slack: confirmed,
			origin: { status: 'delivered', receipt: notice!.id },
		})
		expect(f.sends).toHaveLength(1)
	})

	async function makeObservationDue(f: Awaited<ReturnType<typeof fixture>>) {
		await db
			.update(tasks)
			.set({ automatic_delivery: { ...(await f.state()), managedAt: Date.now() - 61_000 } })
			.where(eq(tasks.id, f.taskId))
	}

	async function launchAttentionRecovery(
		effortLevels: string[],
		humanCheckpointsSatisfied = true,
		findings: DeliveryReview['findings'] = [],
	) {
		const diagnosisHost = uuidv7()
		const f = await fixture('pr-only', diagnosisHost)
		await db
			.update(sessions)
			.set({ coding_agent: 'codelayer', provider: 'codex', model: 'gpt-6.1-sol' })
			.where(eq(sessions.id, f.source.id))
		await db.insert(onlineHosts).values({
			host_id: diagnosisHost,
			organization_id: organizationId,
			user_id: 'owner',
			supported_models: {
				probedAt: Date.now(),
				anthropic: { status: 'unavailable', reason: 'Test host has only Codex', models: [] },
				codex: {
					status: 'ok',
					models: [
						{
							provider: 'codex',
							value: DELIVERY_DIAGNOSIS_MODEL,
							label: 'GPT-6.2 Sol',
							isDefault: false,
							hidden: false,
							effortLevels,
							supportsFastMode: false,
							supportsAutoMode: false,
						},
					],
				},
			},
		})
		await f.reachReview()
		await f.review({
			verdict: 'uncertain',
			humanCheckpointsSatisfied,
			findings,
			evidence: 'The review result is absent from the expected PR revision.',
		})
		await f.idle()
		expect(await f.claim()).toBeNull()
		const recoveryId = (await f.state()).managedSessionId!
		const [recovery] = await db.select().from(sessions).where(eq(sessions.id, recoveryId))
		return { ...f, diagnosisHost, recovery: recovery! }
	}

	it('uses one Sol high diagnostic for unclear recovery and accepts only its bounded owner-host artifact', async () => {
		const f = await launchAttentionRecovery(['medium', 'high'])
		expect(f.recovery).toMatchObject({
			id: (await f.state()).managedSessionId,
			host_id: f.diagnosisHost,
			model: DELIVERY_DIAGNOSIS_MODEL,
			effort: 'high',
			permissions_mode: 'default',
			labels: expect.arrayContaining([{ name: DELIVERY_DIAGNOSIS_LABEL, title: 'Read-only blocker diagnosis' }]),
		})
		expect(f.recovery.prompt).toContain('The review result is absent from the expected PR revision.')
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.recovery.id))
		const context = createMockDaemonContext({
			auth: createMockDaemonAuth({ userId: 'owner', organizationId, hostId: f.diagnosisHost }),
			services: { db, dbReadReplica: db },
		})
		const wrongHost = createMockDaemonContext({
			auth: createMockDaemonAuth({ userId: 'owner', organizationId, hostId: uuidv7() }),
			services: { db, dbReadReplica: db },
		})
		const diagnosis = { reason: 'Review evidence is missing.', nextAction: 'Check the current PR review.' }
		const input = {
			taskId: f.taskId,
			sessionId: f.recovery.id,
			fileName: `delivery-diagnosis-${f.recovery.id}.json`,
			content: JSON.stringify(diagnosis),
		}
		await expect(call(upsertArtifactProcedure, input, { context: wrongHost })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		await expect(
			call(
				upsertArtifactProcedure,
				{ ...input, content: JSON.stringify({ ...diagnosis, reason: 'Line 1\nLine 2' }) },
				{ context },
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		const prior = await f.state()
		await call(upsertArtifactProcedure, input, { context })
		await call(upsertArtifactProcedure, input, { context })
		expect(await f.state()).toMatchObject({
			phase: 'attention',
			passes: prior.passes,
			recoveryAttempts: 1,
			attention: prior.attention,
			attentionDiagnosis: diagnosis,
		})
		await expect(
			call(
				upsertArtifactProcedure,
				{ ...input, content: JSON.stringify({ ...diagnosis, reason: 'Replacement.' }) },
				{ context },
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
	})

	it('keeps ordinary recovery for known human gates, recorded findings, and hosts without Sol high', async () => {
		for (const [levels, checkpoint, findings] of [
			[['medium', 'high'], false, []],
			[['medium'], true, []],
			[
				['medium', 'high'],
				true,
				[{ priority: 'P1', related: true, verified: true, detail: 'Known test failure' }],
			],
		] as const) {
			const f = await launchAttentionRecovery([...levels], checkpoint, [...findings])
			expect(f.recovery).toMatchObject({ model: 'gpt-6.1-sol', effort: null })
			expect(f.recovery.labels?.some((label) => label.name === DELIVERY_DIAGNOSIS_LABEL)).toBe(false)
			expect((await f.state()).recoveryAttempts).toBe(1)
		}
	})

	it('reminds once per 24 hours after recovery ends and stops after the owner acknowledges the exact blocker', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await f.reachReview()
		await f.review({ verdict: 'blocked', humanCheckpointsSatisfied: false })
		await f.idle()
		await f.heartbeat()
		await f.idle()
		await f.heartbeat()
		const exhausted = await f.state()
		const original = exhausted.blockerAlert!
		expect(original).toMatchObject({
			exhaustedAt: expect.any(Number),
			slack: confirmed,
			origin: { status: 'delivered' },
		})

		await f.heartbeat()
		expect(f.sends).toHaveLength(1)
		const day = 24 * 60 * 60_000
		await db
			.update(tasks)
			.set({
				automatic_delivery: { ...exhausted, blockerAlert: { ...original, exhaustedAt: Date.now() - day - 1 } },
			})
			.where(eq(tasks.id, f.taskId))
		await makeObservationDue(f)
		const { action } = await f.heartbeat(true)
		expect(action?.kind).toBe('observe')
		expect(f.sends).toHaveLength(1)
		expect(await f.completeObservedMerge(action!.leaseId)).toEqual({ accepted: true })
		await f.heartbeat()
		const reminded = await f.state()
		expect(reminded.blockerAlert).toMatchObject({
			id: original.id,
			slack: original.slack,
			origin: original.origin,
			reminder: { slack: confirmed, origin: { status: 'delivered' } },
		})
		expect(reminded.blockerAlert?.reminder?.id).not.toBe(original.id)
		expect(reminded.recoveryAttempts).toBe(1)
		expect(f.sends).toHaveLength(2)
		expect((await f.notices()).map((notice) => notice.content).join('\n')).toContain(
			'Still needs attention after 24 hours. PR merged on GitHub. Verify remaining acceptance',
		)

		const ackContext = {
			context: createMockApiContext({
				auth: createMockApiAuth({ organizationId, userId: 'owner' }),
				services: { db, dbReadReplica: db },
			}),
		}
		expect(
			await call(acknowledgeDeliveryBlockerProcedure, { taskId: f.taskId, alertId: uuidv7() }, ackContext),
		).toEqual({ acknowledged: false })
		expect(
			await call(acknowledgeDeliveryBlockerProcedure, { taskId: f.taskId, alertId: original.id }, ackContext),
		).toEqual({ acknowledged: true })

		const acknowledged = await f.state()
		await db
			.update(tasks)
			.set({
				automatic_delivery: {
					...acknowledged,
					blockerAlert: {
						...acknowledged.blockerAlert!,
						reminder: { ...acknowledged.blockerAlert!.reminder!, reservedAt: Date.now() - day - 1 },
					},
				},
			})
			.where(eq(tasks.id, f.taskId))
		await f.heartbeat()
		expect(f.sends).toHaveLength(2)
		expect(await f.notices()).toHaveLength(2)
		expect((await f.state()).phase).toBe('attention')
	})

	it('observes a manual merge after Main recovery while keeping the Meetily acceptance gate and confirmed alerts', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await f.reachReview()
		await f.review({ verdict: 'blocked', humanCheckpointsSatisfied: false })
		await f.idle()
		expect((await f.heartbeat()).action).toBeNull()
		expect((await f.state()).recoveryAttempts).toBe(1)

		await f.idle()
		expect((await f.heartbeat()).action).toBeNull()
		const before = await f.state()
		const [notice] = await f.notices()
		expect(before).toMatchObject({
			phase: 'attention',
			managedSessionId: null,
			attention: expect.stringContaining('No further automatic recovery'),
			blockerAlert: { slack: confirmed, origin: { status: 'delivered', receipt: notice?.id } },
		})

		await makeObservationDue(f)
		expect((await f.heartbeat()).action).toBeNull()
		const { action } = await f.heartbeat(true)
		expect(action).toMatchObject({ kind: 'observe', targets: [target], heads: [head] })
		expect((await f.heartbeat(true)).action).toBeNull()
		const merged = { ...head, merged: true, draft: false }
		expect(await f.complete(action!.leaseId, [merged])).toBe(true)
		const result = await f.state()
		expect(result).toMatchObject({
			phase: 'attention',
			passes: before.passes,
			recoveryAttempts: 1,
			attention: before.attention,
			blockerAlert: before.blockerAlert,
			reviews: before.reviews,
			deliverySessionIds: before.deliverySessionIds,
			heads: before.heads,
			attentionObservation: { checkedAt: expect.any(Number), heads: [merged] },
		})
		const [task] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		expect(task?.archived).toBe(false)
		const taskSessions = await db.select().from(sessions).where(eq(sessions.task_id, f.taskId))
		expect(describeBoardTask({ automatic_delivery: result }, taskSessions)).toMatchObject({
			columnId: 'in-review',
			delivery: {
				status: 'blocked',
				reason: expect.stringContaining('Verify remaining acceptance'),
				alert: { slack: 'delivered', origin: 'delivered' },
			},
		})

		await makeObservationDue(f)
		const [beforeFailedCheck] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		const check = (await f.heartbeat(true)).action
		expect(check?.kind).toBe('observe')
		expect(await f.complete(check!.leaseId, [], 'GitHub unavailable')).toBe(true)
		expect((await f.state()).attentionObservation).toEqual(result.attentionObservation)
		const [afterFailedCheck] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		expect(afterFailedCheck?.updated_at).toBe(beforeFailedCheck?.updated_at)

		await makeObservationDue(f)
		const [beforeUnchangedCheck] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		const unchanged = (await f.heartbeat(true)).action
		expect(unchanged?.kind).toBe('observe')
		expect(await f.complete(unchanged!.leaseId, [merged])).toBe(true)
		const [afterUnchangedCheck] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		expect(afterUnchangedCheck?.updated_at).toBe(beforeUnchangedCheck?.updated_at)
		const observation = (await f.state()).attentionObservation
		expect(observation?.checkedAt).toBeGreaterThanOrEqual(result.attentionObservation!.checkedAt)
		expect(observation?.changedAt).toBe(result.attentionObservation?.changedAt)
		expect(f.sends).toHaveLength(1)
		expect(await f.notices()).toHaveLength(1)
	})

	it('rejects an expired or superseded observation and fences changes to the task', async () => {
		const f = await fixture()
		await db
			.update(tasks)
			.set({
				automatic_delivery: {
					...(await f.state()),
					phase: 'attention',
					attention: 'Recovery exhausted.',
					recoveryAttempts: 1,
					passes: 3,
					heads: [head],
					managedAt: 0,
				},
			})
			.where(eq(tasks.id, f.taskId))
		const first = await f.claim(true)
		expect(first?.kind).toBe('observe')
		const leased = await f.state()
		await db
			.update(tasks)
			.set({ automatic_delivery: { ...leased, managedAt: 0, lease: { ...leased.lease!, expiresAt: 0 } } })
			.where(eq(tasks.id, f.taskId))
		const merged = { ...head, merged: true, draft: false }
		expect(await f.complete(first!.leaseId, [merged])).toBe(false)

		const second = await f.claim(true)
		expect(second?.kind).toBe('observe')
		expect(second?.leaseId).not.toBe(first?.leaseId)
		expect(await f.complete(first!.leaseId, [merged])).toBe(false)
		await db.update(tasks).set({ ticket_description: 'A different acceptance gate.' }).where(eq(tasks.id, f.taskId))
		expect(await f.complete(second!.leaseId, [merged])).toBe(false)
		expect(await f.state()).toMatchObject({ phase: 'attention', passes: 3, recoveryAttempts: 1 })
		expect((await f.state()).attentionObservation).toBeUndefined()
	})

	it('confirms Slack and retains the unavailable external origin gap', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId })
		await f.block()
		await f.heartbeat()
		expect((await f.state()).blockerAlert).toMatchObject({ slack: confirmed, origin: { status: 'unavailable' } })
		expect(await f.notices()).toHaveLength(0)
	})

	it('keeps the valid Slack route when the requested conversation belongs to a different task', async () => {
		const f = await alertFixture()
		const unrelated = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: unrelated.origin })
		await f.block()
		await f.heartbeat()
		expect((await f.state()).blockerAlert).toMatchObject({
			slack: confirmed,
			origin: { status: 'unavailable' },
		})
		expect(await unrelated.notices()).toHaveLength(0)
	})

	it('keeps the valid native origin when the requested Slack automation is unavailable', async () => {
		const f = await alertFixture()
		await db
			.update(slackNotificationAutomations)
			.set({ enabled: false })
			.where(eq(slackNotificationAutomations.id, f.slackAutomationId))
		await expect(f.configure({ slackAutomationId: f.slackAutomationId })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		expect(await f.configure({})).toMatchObject({ delivery: { alertRoutes: {} } })
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await f.block()
		await f.heartbeat()
		expect((await f.state()).blockerAlert).toMatchObject({
			slack: { status: 'unavailable' },
			origin: { status: 'delivered' },
		})
		expect(f.sends).toHaveLength(0)
		expect(await f.notices()).toHaveLength(1)
	})

	it('rejects Slack channel drift while confirming the authorized native origin', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await db
			.update(slackNotificationAutomations)
			.set({ channel_id: 'C_DIFFERENT' })
			.where(eq(slackNotificationAutomations.id, f.slackAutomationId))
		await f.block()
		await f.heartbeat()
		expect((await f.state()).blockerAlert).toMatchObject({
			slack: { status: 'unavailable' },
			origin: { status: 'delivered' },
		})
		expect(f.sends).toHaveLength(0)
		expect(await f.notices()).toHaveLength(1)
	})

	for (const status of ['failed', 'unknown'] as const) {
		it(`retains the ${status} Slack result and confirms the independently delivered native event`, async () => {
			const f = await alertFixture(async () => ({ status }))
			await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
			await f.block()
			await f.heartbeat()
			await f.heartbeat()
			expect((await f.state()).blockerAlert).toMatchObject({ slack: { status }, origin: { status: 'delivered' } })
			expect(f.sends).toHaveLength(1)
			expect(await f.notices()).toHaveLength(1)
		})
	}

	it('shares one Slack receipt when a task thread is bound for both routes, including late binding', async () => {
		for (const late of [false, true]) {
			const f = await alertFixture()
			const origin = await f.thread()
			await f.configure({ slackAutomationId: f.slackAutomationId, origin: late ? undefined : origin })
			await f.block()
			await f.heartbeat()
			if (late) {
				await f.configure({ slackAutomationId: f.slackAutomationId, origin })
				await f.heartbeat()
			}
			expect(f.sends).toHaveLength(1)
			expect(f.sends[0]?.threadTs).toBe('1710000000.000001')
			expect((await f.state()).blockerAlert).toMatchObject({ slack: confirmed, origin: confirmed })
		}
	})

	it('confirms a matching origin bound while its Slack post is already in flight', async () => {
		const started = Promise.withResolvers<void>()
		const provider = Promise.withResolvers<DeliveryAlertReceipt>()
		const f = await alertFixture(() => {
			started.resolve()
			return provider.promise
		})
		const origin = await f.thread()
		await f.configure({ slackAutomationId: f.slackAutomationId })
		await f.block()
		const posting = f.heartbeat()
		try {
			await Promise.race([
				started.promise,
				posting.then(() => {
					throw new Error('Expected pending Slack post')
				}),
			])
			await f.configure({ slackAutomationId: f.slackAutomationId, origin })
			await f.heartbeat()
			expect((await f.state()).blockerAlert).toMatchObject({
				slack: { status: 'unknown' },
				origin: { status: 'unknown' },
			})
		} finally {
			provider.resolve(confirmed)
			await posting
		}
		expect(f.sends).toHaveLength(1)
		expect((await f.state()).blockerAlert).toMatchObject({ slack: confirmed, origin: confirmed })
	})

	it('keeps Describe PR on the task through queued, blocked, resumed, and verification states', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		expect(await f.claim()).toBeNull()
		const initial = await f.state()
		expect(initial.phase).toBe('pr')
		expect(initial.managedSessionId).not.toBe(f.source.id)
		const describe = async () =>
			describeBoardTask(
				{ automatic_delivery: await f.state() },
				await db.select().from(sessions).where(eq(sessions.task_id, f.taskId)),
			)
		expect(await describe()).toMatchObject({ columnId: 'implementation', delivery: { status: 'queued' } })
		const status = (status: typeof sessions.$inferSelect.status) =>
			db.update(sessions).set({ status }).where(eq(sessions.id, initial.managedSessionId!))
		await status('needs_approval')
		await f.heartbeat()
		expect(await describe()).toMatchObject({
			columnId: 'implementation',
			delivery: { status: 'blocked', alert: { slack: 'delivered', origin: 'delivered' } },
		})
		expect((await f.state()).phase).toBe('pr')
		await status('running')
		await f.heartbeat()
		expect(await describe()).toMatchObject({ columnId: 'implementation', delivery: { status: 'running' } })
		await status('ready_for_input')
		const next = await f.claim()
		expect(next?.kind).toBe('inspect')
		await f.complete(next!.leaseId, [], 'Missing verified pull request.')
		expect(await describe()).toMatchObject({
			columnId: 'implementation',
			delivery: { status: 'blocked', reason: expect.stringContaining('Missing verified pull request.') },
		})
	})

	it('sends fresh alerts when a delivered Describe PR hold becomes a terminal blocker', async () => {
		const f = await alertFixture()
		await f.configure({ slackAutomationId: f.slackAutomationId, origin: f.origin })
		await f.claim()
		const sessionId = (await f.state()).managedSessionId!
		await db.update(sessions).set({ status: 'waiting_for_usage_limit' }).where(eq(sessions.id, sessionId))
		await f.heartbeat()
		const held = (await f.state()).blockerAlert
		expect(held).toMatchObject({ slack: confirmed, origin: { status: 'delivered' } })
		await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, sessionId))
		await f.heartbeat()
		const terminal = await f.state()
		expect(terminal.attention).toContain('Describe PR stopped')
		expect(terminal.blockerAlert).toMatchObject({ slack: confirmed, origin: { status: 'delivered' } })
		expect(terminal.blockerAlert?.id).not.toBe(held?.id)
		expect(f.sends).toHaveLength(2)
		expect(await f.notices()).toHaveLength(2)
	})

	for (const repair of [false, true]) {
		it.effect(`verifies archive-only work without reopening a merged branch (repair=${repair})`, () =>
			Effect.promise(async () => {
				const f = await fixture('archive-only')
				const inspect = await f.claim()
				expect(inspect?.kind).toBe('inspect')
				await f.complete(inspect!.leaseId, [{ ...head, merged: true }])
				await f.review(
					repair
						? {
								verdict: 'repair',
								findings: [
									{
										priority: 'P2',
										verified: true,
										related: true,
										detail: 'Already merged defect requires follow-up',
									},
								],
							}
						: {},
				)
				if (repair) {
					expect((await f.state()).phase).toBe('attention')
					expect((await f.state()).attention).toContain('already merged')
				} else {
					await f.idle()
					const refresh = await f.claim()
					await f.complete(refresh!.leaseId, [{ ...head, merged: true }])
					const archive = await f.claim()
					expect(archive?.kind).toBe('archive')
					await f.complete(archive!.leaseId, [{ ...head, merged: true }])
					expect((await f.state()).phase).toBe('archived')
				}
			}),
		)
	}

	it.effect('provides later human merge limits to independent QA', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await db.insert(conversationEvents).values({
				session_id: f.source.id,
				task_id: f.taskId,
				organization_id: organizationId,
				resource_owner_user_id: 'owner',
				user_id: 'owner',
				role: 'user',
				event_type: 'message',
				content: 'Human instruction: manual merge is required for this task.',
			})
			await f.reachReview()
			const state = await f.state()
			const [reviewer] = await db.select().from(sessions).where(eq(sessions.id, state.managedSessionId!))
			expect(reviewer?.prompt).toContain('Human instruction: manual merge is required for this task.')
			await f.review({ automaticMergeAllowed: false })
			expect((await f.state()).phase).toBe('attention')
		}),
	)

	it.effect('services other tasks before returning to a just-serviced delivery', () =>
		Effect.promise(async () => {
			const isolatedHost = uuidv7()
			const f = await fixture('merge', isolatedHost)
			const g = await fixture('merge', isolatedHost)
			for (const [entry, age] of [
				[f, 2_000],
				[g, 1_000],
			] as const) {
				await entry.reachReview()
				await entry.review()
				await entry.idle()
				const state = await entry.state()
				state.managedAt -= age
				await db.update(tasks).set({ automatic_delivery: state }).where(eq(tasks.id, entry.taskId))
			}
			const context = createMockDaemonContext({
				auth: createMockDaemonAuth({ userId: 'owner', organizationId, hostId: isolatedHost }),
				services: { db, dbReadReplica: db },
			})
			const first = await call(claimDeliveryProcedure, {}, { context })
			expect(first.action?.taskId).toBe(f.taskId)
			await f.complete(first.action!.leaseId, [{ ...head, merged: true }])
			const next = await call(claimDeliveryProcedure, {}, { context })
			expect(next.action?.taskId).toBe(g.taskId)
		}),
	)

	it.effect('accepts exact-head review through daemon artifact sync without an owner CLI login', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await f.reachReview()
			const state = await f.state()
			const sessionId = state.managedSessionId!
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, sessionId))
			const review: DeliveryReview = {
				sessionId,
				source: 'local-qa',
				verdict: 'clean',
				automaticMergeAllowed: true,
				humanCheckpointsSatisfied: true,
				heads: state.heads,
				findings: [],
				evidence: 'Independent exact-head QA',
			}
			const input = {
				taskId: f.taskId,
				sessionId,
				fileName: `delivery-review-${sessionId}.json`,
				content: JSON.stringify(review),
				operationType: 'Write' as const,
				operationContents: {},
			}
			const context = createMockDaemonContext({
				auth: createMockDaemonAuth({ userId: 'owner', organizationId, hostId }),
				services: { db, dbReadReplica: db },
			})
			await expect(call(upsertArtifactProcedure, { ...input, content: '{' }, { context })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
			})
			const wrongHost = createMockDaemonContext({
				auth: createMockDaemonAuth({ userId: 'owner', organizationId, hostId: uuidv7() }),
				services: { db, dbReadReplica: db },
			})
			await expect(call(upsertArtifactProcedure, input, { context: wrongHost })).rejects.toMatchObject({
				code: 'FORBIDDEN',
			})
			await call(upsertArtifactProcedure, input, { context })
			await call(upsertArtifactProcedure, input, { context })
			const result = await f.state()
			expect(result.phase).toBe('inspect')
			expect(result.reviews).toHaveLength(1)
			expect(result.reviews[0]?.sessionId).toBe(sessionId)
		}),
	)

	it.effect('continues without browser, reserves once across callbacks, and archives using stock semantics', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await Promise.all(Array.from({ length: 5 }, () => f.claim()))
			expect((await f.state()).deliverySessionIds).toHaveLength(1)
			await f.idle()
			const actions = await Promise.all(Array.from({ length: 5 }, () => f.claim()))
			expect(actions.filter(Boolean)).toHaveLength(1)
			const inspect = actions.find(Boolean)!
			await f.complete(inspect.leaseId)
			expect(await f.review()).toBe(true)
			await f.idle()
			const refreshed = await f.claim()
			expect(refreshed?.kind).toBe('inspect')
			await f.complete(refreshed!.leaseId)
			const merge = await f.claim()
			expect(merge?.kind).toBe('merge')
			expect(await f.claim()).toBeNull()
			await f.complete(merge!.leaseId, [{ ...head, merged: true }])
			const archive = await f.claim()
			expect(archive?.kind).toBe('archive')
			await f.complete(archive!.leaseId, [{ ...head, merged: true }])
			const [task] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
			expect(task?.archived).toBe(true)
			expect(await db.select().from(sessions).where(eq(sessions.task_id, f.taskId))).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: f.source.id, archived: true })]),
			)
			expect(await f.claim()).toBeNull()
		}),
	)

	it.effect('repairs verified findings and stops permanently at three review passes', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await f.reachReview()
			for (let pass = 1; pass <= 3; pass++) {
				expect((await f.state()).passes).toBe(pass)
				await f.review({
					verdict: 'repair',
					findings: [{ priority: 'P2', verified: true, related: true, detail: 'Reproduced defect' }],
				})
				await f.idle()
				await f.claim()
				if (pass < 3) {
					expect((await f.state()).phase).toBe('repair')
					await f.idle()
					const inspect = await f.claim()
					await f.complete(inspect!.leaseId, [{ ...head, sha: String(pass).repeat(40) }])
				}
			}
			expect((await f.state()).phase).toBe('attention')
			expect((await f.state()).recoveryAttempts).toBe(1)
			await f.idle()
			await f.claim()
			await f.claim()
			expect((await f.state()).passes).toBe(3)
			expect((await f.state()).recoveryAttempts).toBe(1)
		}),
	)

	for (const patch of [
		{ verdict: 'uncertain' as const },
		{ verdict: 'blocked' as const },
		{ automaticMergeAllowed: false },
		{ humanCheckpointsSatisfied: false },
	]) {
		it.effect(`fails closed for review ${JSON.stringify(patch)}`, () =>
			Effect.promise(async () => {
				const f = await fixture()
				await f.reachReview()
				await f.review(patch)
				expect((await f.state()).phase).toBe('attention')
			}),
		)
	}

	it.effect('does not merge PR-only tasks and requires all reviewed heads for archive', () =>
		Effect.promise(async () => {
			const f = await fixture('pr-only')
			await f.reachReview()
			await f.review({ automaticMergeAllowed: false })
			await f.idle()
			const inspect = await f.claim()
			expect(inspect?.kind).toBe('inspect')
			await f.complete(inspect!.leaseId, [{ ...head, merged: true }])
			const archive = await f.claim()
			expect(archive?.kind).toBe('archive')
			await f.complete(archive!.leaseId, [{ ...head, merged: false }])
			expect((await f.state()).phase).toBe('attention')
		}),
	)

	it.effect('does not repeat an uncertain merge after restart and expired lease', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await f.reachReview()
			await f.review()
			await f.idle()
			const refresh = await f.claim()
			await f.complete(refresh!.leaseId)
			const merge = await f.claim()
			expect(merge?.kind).toBe('merge')
			const current = await f.state()
			current.lease!.expiresAt = 0
			await db.update(tasks).set({ automatic_delivery: current }).where(eq(tasks.id, f.taskId))
			expect(await f.claim()).toBeNull()
			expect((await f.state()).phase).toBe('attention')
		}),
	)

	it.effect('invalidates changed heads, newer sessions, and uncovered branches', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await f.reachReview()
			expect(await f.review({ heads: [{ ...head, sha: 'b'.repeat(40) }] })).toBe(false)
			await f.review()
			await f.idle()
			await expect(f.locked((tx) => guardTaskDeliveryMutation(tx, f.taskId, organizationId))).rejects.toThrow(
				'Automatic delivery',
			)
			await db.insert(sessionRepositories).values({
				organization_id: organizationId,
				session_id: f.source.id,
				task_id: f.taskId,
				host_id: hostId,
				local_path: target.directory,
				repo_full_name: target.repository,
				branch: 'other-work',
			})
			expect(await f.claim()).toBeNull()
			expect((await f.state()).phase).toBe('attention')
			const g = await fixture()
			await g.reachReview()
			await g.review()
			await g.idle()
			await db.update(sessions).set({ num_events: 99 }).where(eq(sessions.id, g.source.id))
			expect(await g.claim()).toBeNull()
			expect((await g.state()).phase).toBe('attention')
		}),
	)

	it.effect('reports unavailable review and worker verification failures', () =>
		Effect.promise(async () => {
			const f = await fixture()
			await f.reachReview()
			await f.idle()
			await f.claim()
			expect((await f.state()).phase).toBe('attention')
			const g = await fixture()
			await g.claim()
			await g.idle()
			const action = await g.claim()
			await g.complete(action!.leaseId, [], 'GitHub unavailable')
			expect((await g.state()).attention).toContain('GitHub unavailable')
		}),
	)
})

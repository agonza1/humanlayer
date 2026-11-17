import { describe, it } from '@effect/vitest'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizations } from '@humanlayer/db/tables/organizations'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { decodeDelivery, type AutomaticDelivery, type DeliveryReview } from '@humanlayer/schemas/zod/automatic-delivery'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect } from 'effect'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, expect } from 'vitest'

import {
	acceptDeliveryReview,
	claimTaskDelivery,
	completeTaskDelivery,
	lockDeliveryTask,
} from '../../src/db/automatic-delivery'
import { guardTaskDeliveryMutation } from '../../src/db/guard-delivery-mutation'
import { upsertArtifactProcedure } from '../../src/orpc/daemon/artifacts/upsert'
import { claimDeliveryProcedure } from '../../src/orpc/daemon/delivery'
import { createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

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

	async function fixture(mode: AutomaticDelivery['mode'] = 'merge', assignedHost = hostId) {
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
				working_directory: target.directory,
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
			local_path: target.directory,
			repo_full_name: target.repository,
			branch: target.branch,
		})
		const delivery: AutomaticDelivery = {
			version: 1,
			authorizedBy: 'owner',
			authorizedAt: Date.now(),
			mode,
			hostId: assignedHost,
			sourceSessionId: source!.id,
			targets: [target],
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
		const claim = () => locked(claimTaskDelivery)
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

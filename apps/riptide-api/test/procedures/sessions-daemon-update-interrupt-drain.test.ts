import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizations } from '@humanlayer/db/tables/organizations'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { reviewProgression } from '@humanlayer/db/tables/review-progression'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { call } from '@orpc/server'
import { and, asc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { acceptedReviewLaunch, retainReviewEnrollment, reviewDigest } from '../../src/db/review-progression'
import { updateSessionProcedure } from '../../src/orpc/daemon/sessions/update'
import { createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('daemon/sessions/update interrupt drain (deliver_on_interrupt)', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let organizationId: string
	const userId = 'user_interrupt_drain'
	const hostId = randomUUID()

	beforeAll(async () => {
		const testDb = await createTestDb('daemon_interrupt_drain')
		cleanupTestDb = testDb.cleanup
		db = testDb.db

		const [org] = await db
			.insert(organizations)
			.values({ name: 'Interrupt Drain Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()

		if (!org) throw new Error('Unable to insert organization for setup')
		organizationId = org.id
	}, 30000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	const createSession = async (overrides: Partial<typeof sessions.$inferInsert> = {}) => {
		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: organizationId,
				resource_owner_user_id: userId,
				created_by: userId,
				host_id: hostId,
				title: 'interrupt drain session',
				working_directory: tmpdir(),
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissions_mode: 'default',
				status: 'running',
				num_events: 5,
				...overrides,
			})
			.returning()

		if (!session) throw new Error('Unable to insert session for setup')
		return session
	}

	const createDaemonContext = () => ({
		context: createMockDaemonContext({
			auth: createMockDaemonAuth({ userId, organizationId, hostId }),
			services: {
				db,
				dbReadReplica: db,
			},
		}),
	})

	const seedQueuedMessage = async (
		sessionId: string,
		content: string,
		opts: {
			minutesAgo?: number
			senderUserId?: string | null
			authorDisplayName?: string | null
			deliverOnInterrupt?: boolean
		} = {},
	) => {
		const { minutesAgo = 0, senderUserId = userId, authorDisplayName = null, deliverOnInterrupt = false } = opts
		const id = uuidv7()
		await db.insert(queuedMessages).values({
			id,
			session_id: sessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			user_id: senderUserId,
			author_display_name: authorDisplayName,
			multiplayer_prompting_active: authorDisplayName !== null,
			content,
			status: 'pending',
			deliver_on_interrupt: deliverOnInterrupt,
			created_at: BigInt(Date.now() - minutesAgo * 60_000),
		})
		return id
	}

	test.each(['missing_receipt', 'content', 'task', 'author', 'active_action'] as const)(
		'enrolled daemon drain rejects %s and rolls back status, events, queue and admission',
		async (tampering) => {
			const taskId = uuidv7()
			await db.insert(tasks).values({
				id: taskId,
				organization_id: organizationId,
				created_by: userId,
				resource_owner_user_id: userId,
				name: 'Enrolled drain',
				slug: 'enrolled-drain',
			})
			const session = await createSession({ task_id: taskId, status: 'interrupt_requested' })
			const messageId = await seedQueuedMessage(session.id, 'Admitted input', { deliverOnInterrupt: true })
			await db.update(queuedMessages).set({ task_id: taskId }).where(eq(queuedMessages.id, messageId))
			await db.transaction((tx) =>
				retainReviewEnrollment(tx, {
					taskId,
					organizationId,
					ownerUserId: userId,
					hostId,
					sourceSessionId: session.id,
					enrollment: { enrollmentId: 'personal', returnRouteRef: 'origin' },
					placement: {
						kind: 'legacy_directory',
						projectId: null,
						workspaceId: null,
						setupRowId: uuidv7(),
						workspaceSpecDigest: null,
					},
					acceptedLaunch: acceptedReviewLaunch({ taskContent: 'Accepted task' }),
				}),
			)
			if (tampering !== 'missing_receipt')
				await db
					.update(reviewProgression)
					.set({
						writer_receipts: [
							{
								key: 'v2.continue:fixture',
								digest: 'a'.repeat(64),
								inputDigest: reviewDigest('Admitted input'),
								sessionId: session.id,
								eventId: uuidv7(),
								messageId,
								executionDigest: 'b'.repeat(64),
								result: { kind: 'continued', transactionId: 'fixture' },
							},
						],
					})
					.where(eq(reviewProgression.task_id, taskId))
			if (tampering === 'content')
				await db
					.update(queuedMessages)
					.set({ content: 'Changed input' })
					.where(eq(queuedMessages.id, messageId))
			if (tampering === 'task')
				await db.update(queuedMessages).set({ task_id: null }).where(eq(queuedMessages.id, messageId))
			if (tampering === 'author')
				await db.update(queuedMessages).set({ user_id: 'collaborator' }).where(eq(queuedMessages.id, messageId))
			if (tampering === 'active_action')
				await db
					.update(reviewProgression)
					.set({ action_id: uuidv7() })
					.where(eq(reviewProgression.task_id, taskId))
			const beforeSession = await db.select().from(sessions).where(eq(sessions.id, session.id))
			const beforeQueue = await db.select().from(queuedMessages).where(eq(queuedMessages.id, messageId))
			const beforeReview = await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, taskId))
			await expect(
				call(updateSessionProcedure, { sessionId: session.id, status: 'interrupted' }, createDaemonContext()),
			).rejects.toMatchObject({ code: 'FORBIDDEN' })
			expect(await db.select().from(sessions).where(eq(sessions.id, session.id))).toEqual(beforeSession)
			expect(await db.select().from(queuedMessages).where(eq(queuedMessages.id, messageId))).toEqual(beforeQueue)
			expect(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, taskId))).toEqual(
				beforeReview,
			)
			expect(
				await db.select().from(conversationEvents).where(eq(conversationEvents.session_id, session.id)),
			).toEqual([])
		},
	)

	test.each(['interrupted', 'ready_for_input'] as const)(
		'stock %s cycles drain eligible input without a running handshake even with a retained usage key',
		async (status) => {
			const session = await createSession()
			const firstId = await seedQueuedMessage(session.id, 'First retained prompt', { deliverOnInterrupt: true })
			const report = { sessionId: session.id, status, usageReportKey: uuidv7(), totalCostUsd: 1 }
			await call(updateSessionProcedure, report, createDaemonContext())
			const laterId = await seedQueuedMessage(session.id, 'Later queued prompt')
			const snapshot = async () => ({
				session: await db.select().from(sessions).where(eq(sessions.id, session.id)),
				queue: await db
					.select()
					.from(queuedMessages)
					.where(eq(queuedMessages.session_id, session.id))
					.orderBy(queuedMessages.id),
				events: await db
					.select()
					.from(conversationEvents)
					.where(eq(conversationEvents.session_id, session.id))
					.orderBy(conversationEvents.id),
			})
			const before = await snapshot()
			expect(before.session[0]).toMatchObject({
				status: 'resuming',
				prompt: 'First retained prompt',
				num_events: 6,
				total_cost_usd: 1,
			})
			expect(before.events).toEqual([expect.objectContaining({ id: firstId })])
			await call(updateSessionProcedure, report, createDaemonContext())
			if (status === 'interrupted') {
				const interrupted = await snapshot()
				expect(interrupted.session[0]).toMatchObject({
					status: 'interrupted',
					prompt: 'First retained prompt',
					num_events: 6,
					total_cost_usd: 1,
				})
				expect(interrupted.queue).toEqual(before.queue)
				expect(interrupted.events).toEqual(before.events)
				expect(interrupted.queue.find((item) => item.id === laterId)?.status).toBe('pending')
				await db
					.update(queuedMessages)
					.set({ deliver_on_interrupt: true })
					.where(eq(queuedMessages.id, laterId))
				await call(updateSessionProcedure, report, createDaemonContext())
			}
			const drained = await snapshot()
			expect(drained.session[0]).toMatchObject({
				status: 'resuming',
				prompt: 'Later queued prompt',
				num_events: 7,
				total_cost_usd: 1,
			})
			expect(drained.events.map((item) => item.id).sort()).toEqual([firstId, laterId].sort())
			expect(drained.queue.every((item) => item.status === 'delivered')).toBe(true)
			await call(updateSessionProcedure, report, createDaemonContext())
			const completed = await snapshot()
			expect(completed.session[0]).toMatchObject({ status, num_events: 7, total_cost_usd: 1 })
			expect(completed.events).toEqual(drained.events)
			expect(completed.queue).toEqual(drained.queue)
		},
		15_000,
	)

	test('interrupted with flagged rows: attributed conv events + resuming', async () => {
		const session = await createSession({ num_events: 10 })

		// Insert a flagged row (interrupt-and-send message)
		const msgId = await seedQueuedMessage(session.id, 'Fix the bug please', {
			senderUserId: 'author-alice',
			authorDisplayName: 'Alice Ng',
			deliverOnInterrupt: true,
		})

		await call(updateSessionProcedure, { sessionId: session.id, status: 'interrupted' }, createDaemonContext())

		// Session should be overridden to resuming with the prompt set
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('resuming')
		expect(updated?.prompt).toBe('<message from="Alice Ng">\nFix the bug please\n</message>')
		expect(updated?.num_events).toBe(11)

		// Queue row should be marked delivered
		const [queueRow] = await db.select().from(queuedMessages).where(eq(queuedMessages.id, msgId))
		expect(queueRow?.status).toBe('delivered')

		// A conversation event should be inserted with the author's user_id
		const events = await db
			.select()
			.from(conversationEvents)
			.where(
				and(
					eq(conversationEvents.session_id, session.id),
					eq(conversationEvents.role, 'user'),
					eq(conversationEvents.event_type, 'message'),
				),
			)

		expect(events).toHaveLength(1)
		expect(events[0]?.id).toBe(msgId)
		expect(events[0]?.content).toBe('Fix the bug please')
		expect(events[0]?.user_id).toBe('author-alice')
		expect(events[0]?.organization_id).toBe(organizationId)
		expect(events[0]?.resource_owner_user_id).toBe(userId)
		expect(events[0]?.task_id).toBe(session.task_id)
	})

	test('interrupted with no flagged rows: stays interrupted (plain interrupt)', async () => {
		const session = await createSession()

		// Insert an unflagged pending message (normal queue, not interrupt-and-send)
		await seedQueuedMessage(session.id, 'I will wait my turn', {
			deliverOnInterrupt: false,
		})

		await call(updateSessionProcedure, { sessionId: session.id, status: 'interrupted' }, createDaemonContext())

		// Session stays interrupted — no resume override
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('interrupted')

		// The unflagged message stays pending
		const rows = await db.select().from(queuedMessages).where(eq(queuedMessages.session_id, session.id))

		expect(rows).toHaveLength(1)
		expect(rows[0]?.status).toBe('pending')

		// No conversation events inserted
		const events = await db
			.select()
			.from(conversationEvents)
			.where(
				and(
					eq(conversationEvents.session_id, session.id),
					eq(conversationEvents.role, 'user'),
					eq(conversationEvents.event_type, 'message'),
				),
			)

		expect(events).toHaveLength(0)
	})

	test('interrupted with multiple flagged rows from different authors: all delivered and attributed', async () => {
		const session = await createSession({ num_events: 5 })

		// Two users interrupt-and-send concurrently
		const msgId1 = await seedQueuedMessage(session.id, 'Alice says fix it', {
			senderUserId: 'author-alice',
			authorDisplayName: 'Alice Ng',
			deliverOnInterrupt: true,
			minutesAgo: 2,
		})
		const msgId2 = await seedQueuedMessage(session.id, 'Bob says add tests', {
			senderUserId: 'author-bob',
			authorDisplayName: 'Bob Tran',
			deliverOnInterrupt: true,
			minutesAgo: 1,
		})

		await call(updateSessionProcedure, { sessionId: session.id, status: 'interrupted' }, createDaemonContext())

		// Session resumes with concatenated prompt
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('resuming')
		expect(updated?.prompt).toBe(
			[
				'<message from="Alice Ng">\nAlice says fix it\n</message>',
				'<message from="Bob Tran">\nBob says add tests\n</message>',
			].join('\n\n'),
		)
		expect(updated?.num_events).toBe(7)

		// Both queue rows marked delivered
		const rows = await db
			.select()
			.from(queuedMessages)
			.where(eq(queuedMessages.session_id, session.id))
			.orderBy(asc(queuedMessages.created_at))

		expect(rows).toHaveLength(2)
		expect(rows[0]?.id).toBe(msgId1)
		expect(rows[0]?.status).toBe('delivered')
		expect(rows[1]?.id).toBe(msgId2)
		expect(rows[1]?.status).toBe('delivered')

		// Two attributed conversation events in created_at order
		const events = await db
			.select()
			.from(conversationEvents)
			.where(
				and(
					eq(conversationEvents.session_id, session.id),
					eq(conversationEvents.role, 'user'),
					eq(conversationEvents.event_type, 'message'),
				),
			)
			.orderBy(asc(conversationEvents.created_at))

		expect(events).toHaveLength(2)
		expect(events[0]?.content).toBe('Alice says fix it')
		expect(events[0]?.user_id).toBe('author-alice')
		expect(events[1]?.content).toBe('Bob says add tests')
		expect(events[1]?.user_id).toBe('author-bob')
	})

	test('interrupted drain delivers only flagged rows, leaves unflagged pending', async () => {
		const session = await createSession()

		// One flagged (interrupt-and-send) + one unflagged (normal queue)
		const flaggedId = await seedQueuedMessage(session.id, 'Urgent fix', {
			senderUserId: 'author-alice',
			authorDisplayName: 'Alice Ng',
			deliverOnInterrupt: true,
			minutesAgo: 2,
		})
		const unflaggedId = await seedQueuedMessage(session.id, 'Later task', {
			senderUserId: 'author-bob',
			deliverOnInterrupt: false,
			minutesAgo: 1,
		})

		await call(updateSessionProcedure, { sessionId: session.id, status: 'interrupted' }, createDaemonContext())

		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('resuming')
		expect(updated?.prompt).toBe('<message from="Alice Ng">\nUrgent fix\n</message>')

		const rows = await db
			.select()
			.from(queuedMessages)
			.where(eq(queuedMessages.session_id, session.id))
			.orderBy(asc(queuedMessages.created_at))

		expect(rows).toHaveLength(2)
		// Flagged row: delivered
		const flaggedRow = rows.find((r) => r.id === flaggedId)
		expect(flaggedRow?.status).toBe('delivered')
		// Unflagged row: still pending
		const unflaggedRow = rows.find((r) => r.id === unflaggedId)
		expect(unflaggedRow?.status).toBe('pending')
	})

	test('ready_for_input drain still delivers all pending rows (regression)', async () => {
		const session = await createSession({ num_events: 5 })

		// Both flagged and unflagged should be delivered in completion mode
		await seedQueuedMessage(session.id, 'Flagged msg', {
			senderUserId: 'author-alice',
			authorDisplayName: 'Alice Ng',
			deliverOnInterrupt: true,
			minutesAgo: 2,
		})
		await seedQueuedMessage(session.id, 'Normal msg', {
			senderUserId: 'author-bob',
			authorDisplayName: 'Bob Tran',
			deliverOnInterrupt: false,
			minutesAgo: 1,
		})

		await call(updateSessionProcedure, { sessionId: session.id, status: 'ready_for_input' }, createDaemonContext())

		// Session resumes with both messages
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('resuming')
		expect(updated?.prompt).toBe(
			[
				'<message from="Alice Ng">\nFlagged msg\n</message>',
				'<message from="Bob Tran">\nNormal msg\n</message>',
			].join('\n\n'),
		)
		expect(updated?.num_events).toBe(7)

		// Both rows marked delivered
		const rows = await db.select().from(queuedMessages).where(eq(queuedMessages.session_id, session.id))

		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.status === 'delivered')).toBe(true)

		// Both conversation events inserted with correct attribution
		const events = await db
			.select()
			.from(conversationEvents)
			.where(
				and(
					eq(conversationEvents.session_id, session.id),
					eq(conversationEvents.role, 'user'),
					eq(conversationEvents.event_type, 'message'),
				),
			)
			.orderBy(asc(conversationEvents.created_at))

		expect(events).toHaveLength(2)
		expect(events.map((e) => e.user_id)).toEqual(['author-alice', 'author-bob'])
	})

	test('ready_for_input with no pending messages stays ready_for_input (regression)', async () => {
		const session = await createSession()

		await call(updateSessionProcedure, { sessionId: session.id, status: 'ready_for_input' }, createDaemonContext())

		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated?.status).toBe('ready_for_input')
	})
})

import { createHash } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { artifacts } from '@humanlayer/db/tables/artifacts'
import { reviewProgression, type ReviewProgression } from '@humanlayer/db/tables/review-progression'
import { UpsertArtifactInputSchema } from '@humanlayer/riptide-api-contract/daemon/artifacts/upsert'
import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import { canonicalReviewValue, reviewHelperScope } from '@humanlayer/riptide-api-contract/lib/review-progression'
import { ReviewReturnInputSchema } from '@humanlayer/riptide-api-contract/lib/review-reporting'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, expect, test, vi } from 'vitest'

import type { ORPCClient } from '@/agents/claudecode/types'
import {
	makeReviewReporting,
	reportDigest,
	reportRequestId,
} from '@/effects/services/review-integration/review-reporting'

const mocks = vi.hoisted(() => ({ permission: vi.fn() }))
vi.mock('../../../riptide-api/src/orpc/base', () => {
	const route = {
		handler: (handler: unknown) => handler,
		use() {
			return this
		},
	}
	return {
		daemonBase: { artifacts: { upsert: route }, reviewProgression: new Proxy({}, { get: () => route }) },
		requiresDaemonBillingMiddleware: vi.fn(),
	}
})
vi.mock('../../../riptide-api/src/db/task-auth', () => ({ getTaskWithEffectivePermissions: mocks.permission }))
vi.mock('../../../riptide-api/src/db/get-tx-id', () => ({ getTxId: async () => '1' }))
vi.mock('../../../riptide-api/src/effects/services/onboarding/onboarding.service', () => ({ OnboardingService: {} }))
vi.mock('../../../riptide-api/src/effects/services/slack/slack.service', () => ({ SlackService: {} }))
vi.mock('../../../riptide-api/src/instrument', () => ({
	Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}))
vi.mock('../../../riptide-api/src/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('@humanlayer/ai/design-doc-open-questions', () => ({ checkIfDesignDocHasOpenQuestions: vi.fn() }))

import { upsertArtifactProcedure } from '../../../riptide-api/src/orpc/daemon/artifacts/upsert'
import {
	reviewProgressionProcedures,
	freshReviewReportOutcome,
} from '../../../riptide-api/src/orpc/daemon/review-progression'

type Row = Record<string, any>
type Handler = (options: { input: unknown; context: unknown; errors: unknown }) => Promise<any>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'report-api-boundary-')))
	await chmod(directory, 0o700)
	cleanup.push(() => rm(directory, { recursive: true, force: true }))
	const auth = { organizationId: 'org', userId: 'owner', hostId: 'host' }
	const taskId = '00000000-0000-7000-8000-000000000001',
		sourceSessionId = '00000000-0000-7000-8000-000000000002'
	const row: Row = {
		task_id: taskId,
		organization_id: auth.organizationId,
		resource_owner_user_id: auth.userId,
		host_id: auth.hostId,
		source_session_id: sourceSessionId,
		enrollment_id: 'fixture',
		scope_inputs: {},
		verified_binding: { repository: 'fixture/project' },
		report_receipts: [],
	}
	const task = {
		id: taskId,
		slug: 'fixture',
		organization_id: auth.organizationId,
		resource_owner_user_id: auth.userId,
	}
	const data: Record<string, Row[]> = {
		artifacts: [],
		artifact_versions: [],
		artifact_operations_log: [],
		tasks: [task],
		review_progression: [row],
		sessions: [
			{
				id: sourceSessionId,
				task_id: taskId,
				organization_id: auth.organizationId,
				coding_agent_session_id: 'actual-source',
			},
		],
		conversation_events: [],
		queued_messages: [],
	}
	const writes: string[] = [],
		locks: string[] = []
	const dialect = new PgDialect()
	const matches = (condition: SQL, value: Row) => {
		const query = dialect.sqlToQuery(condition)
		const predicates = [...query.sql.matchAll(/"\w+"\."(\w+)" = \$(\d+)/g)]
		expect(predicates.length).toBeGreaterThan(0)
		return predicates.every((match) => value[match[1]!] === query.params[Number(match[2]) - 1])
	}
	const tx = {
		select: () => ({
			from: (table: any) => {
				const name = getTableName(table)
				let rows = data[name] ?? []
				const query = {
					where(condition: SQL) {
						rows = rows.filter((value) => matches(condition, value))
						return this
					},
					limit(n: number) {
						rows = rows.slice(0, n)
						return this
					},
					orderBy() {
						return this
					},
					for(mode: string) {
						expect(mode).toBe('update')
						locks.push(name)
						return this
					},
					then(resolve: any, reject: any) {
						return Promise.resolve(rows).then(resolve, reject)
					},
				}
				return query
			},
		}),
		insert: (table: any) => ({
			values: (value: Row) => {
				const name = getTableName(table),
					stored = { storage_type: 'postgres', is_deleted: false, ...value }
				writes.push(name)
				;(data[name] ??= []).push(stored)
				return { returning: async () => [stored] }
			},
		}),
		update: (table: any) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL) => {
					const name = getTableName(table)
					for (const value of data[name] ?? [])
						if (matches(condition, value)) {
							writes.push(name)
							Object.assign(value, patch)
						}
				},
			}),
		}),
	}
	mocks.permission.mockImplementation(async (executor, id, user, organization, options) => {
		expect(executor).toBe(tx)
		expect(options).toEqual({ lockForUpdate: true })
		return id === taskId && user === auth.userId && organization === auth.organizationId
			? { ...task, effectivePermission: 'edit' }
			: null
	})
	let tail = Promise.resolve()
	const context = {
		auth,
		services: {
			db: {
				transaction: (fn: (executor: typeof tx) => Promise<any>) => {
					const next = tail.then(() => fn(tx))
					tail = next.then(
						() => undefined,
						() => undefined,
					)
					return next
				},
			},
			effectRuntime: { runFork: vi.fn() },
		},
	}
	const errors = Object.fromEntries(
		['CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST'].map((code) => [code, () => new Error(code)]),
	)
	const snapshot = {
		taskId,
		sourceSessionId,
		enrollment: { enrollmentId: 'fixture' },
		verifiedBinding: row.verified_binding,
		scopeSha256: reportDigest(reviewHelperScope(row.scope_inputs as any, row.verified_binding)),
	} as ReviewProgressionSnapshot
	const fields = {
		version: 1 as const,
		kind: 'readiness' as const,
		enrollmentId: 'fixture',
		outcomeKey: 'a'.repeat(64),
		repository: 'fixture/project',
		pr: 7,
		headSha: 'b'.repeat(40),
		scopeSha256: snapshot.scopeSha256!,
		evidenceRef: 'fixture',
	}
	const request = { ...fields, requestId: reportRequestId(fields) },
		report = 'Verified report.'
	await writeFile(join(directory, `${request.requestId}.request.json`), JSON.stringify(request), { mode: 0o600 })
	await writeFile(
		join(directory, `${request.requestId}.result.json`),
		JSON.stringify({
			version: 1,
			transportKey: request.requestId,
			requestId: request.requestId,
			outcomeKey: request.outcomeKey,
			status: 'delivered',
			slackReceipt: '123.456',
			contentDigest: reportDigest('slack'),
			report,
		}),
		{ mode: 0o600 },
	)
	const content = `# Review report\n\n${canonicalReviewValue(request)}\n\n${report}\n\nSlack delivery: delivered. Slack receipt: 123.456. Origin-session and artifact receipts are verified independently.\n`
	const api = {
		artifacts: {
			upsert: vi.fn((input) =>
				(upsertArtifactProcedure as unknown as Handler)({
					input: UpsertArtifactInputSchema.parse(input),
					context,
					errors,
				}),
			),
		},
		reviewProgression: {
			reports: vi.fn(async () => ({
				snapshot,
				codingAgentSessionId: 'actual-source',
				outcome: null,
				receipts: [...row.report_receipts],
			})),
			recordDelivery: vi.fn((input) =>
				(reviewProgressionProcedures.recordDelivery as unknown as Handler)({
					input: ReviewReturnInputSchema.parse(input),
					context,
					errors,
				}),
			),
		},
		sessions: {
			events: {
				create: vi.fn(async (input) => {
					if (!data.conversation_events!.some((event) => event.id === input.eventId))
						data.conversation_events!.push({
							id: input.eventId,
							organization_id: auth.organizationId,
							resource_owner_user_id: auth.userId,
							session_id: sourceSessionId,
							task_id: taskId,
							coding_agent_session_id: input.codingAgentSessionId,
							event_type: input.eventType,
							role: input.role,
							content: input.content,
						})
				}),
			},
		},
	}
	const acknowledgements: any[] = [],
		attention = vi.fn()
	const manager = makeReviewReporting(
		api as unknown as ORPCClient,
		async () => ({
			directory,
			requiredReturns: ['origin_session', 'artifact'],
			submit: async (value: any) => {
				acknowledgements.push(value)
				return { ...value, status: 'acknowledged' }
			},
		}),
		attention,
	)
	cleanup.push(() => manager.stop())
	return {
		manager,
		api,
		data,
		row,
		taskId,
		request,
		directory,
		content,
		writes,
		locks,
		attention,
		acknowledgements,
		seed: (patch: Row = {}) => {
			const value = {
				id: '00000000-0000-7000-8000-000000000099',
				task_id: taskId,
				organization_id: auth.organizationId,
				resource_owner_user_id: auth.userId,
				file_name: `review-report-${request.outcomeKey}.md`,
				content,
				storage_type: 'postgres',
				is_deleted: false,
				...patch,
			}
			data[getTableName(artifacts)]!.push(value)
			return value
		},
	}
}

test('real upsert resolves an identical filename to its actual different ID before real receipt verification', async () => {
	const f = await fixture(),
		existing = f.seed(),
		before = structuredClone(existing)
	await f.manager.flush(f.taskId)
	expect(f.acknowledgements).toHaveLength(2)
	expect(f.row.report_receipts.find((receipt: Row) => receipt.destinationSlot === 'artifact').receiptIdentity).toBe(
		existing.id,
	)
	expect(existing).toEqual(before)
	expect(
		f.writes.filter((table) => ['artifacts', 'artifact_versions', 'artifact_operations_log'].includes(table)),
	).toEqual([])
	expect(f.api.artifacts.upsert.mock.calls[0]![0]).toMatchObject({ ifExists: 'match' })
	expect(f.locks.slice(0, 4)).toEqual(['tasks', getTableName(reviewProgression), 'sessions', 'queued_messages'])
})

test.each(['work_revision', 'planning', 'work_stage', 'outcome_digest'] as const)(
	'real fresh-outcome predicate blocks stale readiness after %s while real earlier returns still drain',
	async (change) => {
		const f = await fixture()
		const outcome = {
			status: 'ready_for_human_approval',
			reason: 'verified_readiness',
			verified: true,
			context: {
				repository: f.request.repository,
				taskId: f.taskId,
				scopeSha256: f.request.scopeSha256,
				pr: f.request.pr,
				headSha: f.request.headSha,
			},
			continuation: { kind: 'stop' },
		}
		Object.assign(f.row, {
			last_outcome: outcome,
			last_ack: { revision: '1', digest: reportDigest(outcome) },
			stage: 'stopped',
			continuation: { kind: 'stop' },
			wake_revision: 1n,
			consumed_revision: 1n,
			planning_suspended: false,
		})
		expect(freshReviewReportOutcome(f.row as ReviewProgression)).toEqual(outcome)
		if (change === 'work_revision') f.row.wake_revision = 2n
		if (change === 'planning') f.row.planning_suspended = true
		if (change === 'work_stage') f.row.stage = 'reviewing'
		if (change === 'outcome_digest') f.row.last_ack.digest = 'e'.repeat(64)
		expect(freshReviewReportOutcome(f.row as ReviewProgression)).toBeNull()
		const reports = f.api.reviewProgression.reports.getMockImplementation()!
		f.api.reviewProgression.reports.mockImplementation(
			async () =>
				({
					...(await reports()),
					outcome: freshReviewReportOutcome(f.row as ReviewProgression),
					wakeRevision: f.row.wake_revision.toString(),
					planningSuspended: f.row.planning_suspended,
				}) as never,
		)
		// The real artifact/receipt verifiers still reconcile a confirmed older request.
		await f.manager.flush(f.taskId)
		expect(f.row.report_receipts).toHaveLength(2)
		expect(f.acknowledgements).toHaveLength(2)
		expect(
			f.acknowledgements.every((value) => value.kind === 'return_ack' && value.requestId === f.request.requestId),
		).toBe(true)
		expect(f.attention).not.toHaveBeenCalled()
	},
)

test.each([
	{ content: 'conflicting content' },
	{ is_deleted: true },
	{ storage_type: 's3' },
	{ resource_owner_user_id: 'foreign' },
	{ organization_id: 'foreign' },
])('create-or-match rejects incompatible stored destination without mutation: %j', async (patch) => {
	const f = await fixture(),
		existing = f.seed(patch),
		before = structuredClone(existing)
	await f.manager.flush(f.taskId)
	await f.manager.flush(f.taskId)
	expect(existing).toEqual(before)
	expect(f.writes.filter((table) => table !== getTableName(reviewProgression))).toEqual([])
	expect(f.row.report_receipts.map((receipt: Row) => receipt.destinationSlot)).toEqual(['origin_session'])
	expect(f.acknowledgements.every((value) => value.destinationSlot === 'origin_session')).toBe(true)
	expect(f.attention).toHaveBeenCalled()
})

test('lost real create response reuses the stored artifact and real verifier accepts one immutable receipt', async () => {
	const f = await fixture(),
		upsert = f.api.artifacts.upsert.getMockImplementation()!
	f.api.artifacts.upsert.mockImplementationOnce(async (input) => {
		await upsert(input)
		throw new Error('lost response')
	})
	await f.manager.flush(f.taskId)
	expect(f.row.report_receipts).toHaveLength(1)
	await f.manager.flush(f.taskId)
	expect(f.data.artifacts).toHaveLength(1)
	expect(f.data.artifact_versions).toHaveLength(0)
	expect(f.row.report_receipts).toHaveLength(2)
	expect(f.acknowledgements.filter((value) => value.destinationSlot === 'artifact')).toHaveLength(1)
})

test('real verifier rejects a nonexistent proposed ID and a wrong digest even when a matching filename exists', async () => {
	const f = await fixture(),
		existing = f.seed()
	const input = {
		kind: 'return_receipt',
		taskId: f.taskId,
		sourceSessionId: '00000000-0000-7000-8000-000000000002',
		request: f.request,
		deliveryStatus: 'delivered',
		destinationSlot: 'artifact',
		receiptIdentity: '00000000-0000-7000-8000-000000000088',
		contentDigest: 'd'.repeat(64),
	}
	await expect(f.api.reviewProgression.recordDelivery(input)).rejects.toThrow('FORBIDDEN')
	await expect(f.api.reviewProgression.recordDelivery({ ...input, receiptIdentity: existing.id })).rejects.toThrow(
		'FORBIDDEN',
	)
	expect(f.row.report_receipts).toEqual([])
	expect(f.acknowledgements).toEqual([])
})

test('ordinary upsert without create-or-match retains its existing update and version behavior', async () => {
	const f = await fixture(),
		existing = f.seed({ content: 'old report' })
	const output = await f.api.artifacts.upsert({
		taskId: f.taskId,
		fileName: existing.file_name,
		content: 'updated report',
	})
	expect(output).toMatchObject({ artifactId: existing.id, created: false, versionNumber: 1 })
	expect(existing.content).toBe('updated report')
	expect(f.data.artifact_versions).toHaveLength(1)
	expect(f.data.artifact_versions![0]!.content).toBe('old report')
})

test('lost real receipt response replays confirmed identity without modifying the artifact again', async () => {
	const f = await fixture(),
		record = f.api.reviewProgression.recordDelivery.getMockImplementation()!
	f.api.reviewProgression.recordDelivery.mockImplementation(async (input) => {
		const receipt = await record(input)
		if (input.destinationSlot === 'artifact') throw new Error('lost receipt response')
		return receipt
	})
	await f.manager.flush(f.taskId)
	expect(f.row.report_receipts).toHaveLength(2)
	expect(f.acknowledgements).toHaveLength(1)
	await f.manager.flush(f.taskId)
	expect(f.api.artifacts.upsert).toHaveBeenCalledTimes(1)
	expect(f.row.report_receipts).toHaveLength(2)
	expect(f.acknowledgements.filter((value) => value.destinationSlot === 'artifact')).toHaveLength(1)
})

async function mergeFiles(
	f: Awaited<ReturnType<typeof fixture>>,
	status: 'merged' | 'declined' = 'merged',
	patch: Row = {},
) {
	const result =
		status === 'merged'
			? { status, headSha: f.request.headSha, mergeCommit: 'd'.repeat(40) }
			: { status, headSha: f.request.headSha }
	const outcomeKey = reportDigest({ kind: 'merge_result', parentRequestId: f.request.requestId, result })
	const fields = {
		...f.request,
		kind: 'merge_result' as const,
		parentRequestId: f.request.requestId,
		mergeResult: result,
		outcomeKey,
		evidenceRef: outcomeKey,
		...patch,
	}
	const request = { ...fields, requestId: reportRequestId(fields) }
	await writeFile(join(f.directory, `${request.requestId}.request.json`), JSON.stringify(request), { mode: 0o600 })
	await writeFile(
		join(f.directory, `${request.requestId}.result.json`),
		JSON.stringify({
			version: 1,
			transportKey: request.requestId,
			requestId: request.requestId,
			outcomeKey: request.outcomeKey,
			status: 'delivered',
			slackReceipt: '125.456',
			contentDigest: reportDigest('merge'),
			report: JSON.stringify(result),
		}),
		{ mode: 0o600 },
	)
	return request
}

test('real result verifier binds a separate merge outcome to the actual earlier readiness artifact and retains distinct return receipts', async () => {
	const f = await fixture(),
		earlier = f.seed(),
		before = structuredClone(earlier)
	await f.manager.flush(f.taskId)
	const outcome = await mergeFiles(f)
	await f.manager.flush(f.taskId)
	expect(f.row.report_receipts).toHaveLength(4)
	expect(f.data.artifacts).toHaveLength(2)
	expect(earlier).toEqual(before)
	expect(f.data.artifact_versions).toHaveLength(0)
	expect(f.data.conversation_events!.map((event) => JSON.parse(event.content).status)).toEqual([
		'ready_for_human_approval',
		'merged',
	])
	expect(f.acknowledgements.filter((value) => value.requestId === outcome.requestId)).toHaveLength(2)
	expect(f.row.report_receipts.filter((receipt: Row) => receipt.requestId === f.request.requestId)).toHaveLength(2)
})

test.each([
	'missing_parent_receipt',
	'changed_parent_bytes',
	'foreign_parent',
	'changed_parent_head',
	'wrong_result_event',
])('real result verifier refuses an unverified parent or mismatched passive event: %s', async (fault) => {
	const f = await fixture(),
		parent = f.seed()
	await f.manager.flush(f.taskId)
	const outcome = await mergeFiles(f)
	if (fault === 'missing_parent_receipt') {
		f.row.report_receipts = []
		await unlink(join(f.directory, `${f.request.requestId}.request.json`))
	}
	if (fault === 'changed_parent_bytes') parent.content += '\nChanged'
	if (fault === 'foreign_parent') parent.resource_owner_user_id = 'other'
	if (fault === 'changed_parent_head') {
		parent.content = parent.content.replaceAll(f.request.headSha, 'e'.repeat(40))
		const receipt = f.row.report_receipts.find((value: Row) => value.destinationSlot === 'artifact')
		receipt.contentDigest = createHash('sha256').update(parent.content).digest('hex')
	}
	if (fault === 'wrong_result_event') {
		const create = f.api.sessions.events.create.getMockImplementation()!
		f.api.sessions.events.create.mockImplementation(async (input) =>
			create({ ...input, content: input.content.replace('"merged"', '"ready_for_human_approval"') }),
		)
	}
	await f.manager.flush(f.taskId)
	const receipts = f.row.report_receipts.filter((value: Row) => value.requestId === outcome.requestId)
	expect(receipts.map((value: Row) => value.destinationSlot)).toEqual(
		fault === 'wrong_result_event' ? ['artifact'] : [],
	)
	expect(
		f.acknowledgements
			.filter((value) => value.requestId === outcome.requestId)
			.map((value) => value.destinationSlot),
	).toEqual(fault === 'wrong_result_event' ? ['artifact'] : [])
	expect(f.attention).toHaveBeenCalled()
})

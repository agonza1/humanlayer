import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReviewReportReceipt } from '@humanlayer/db/zodschemas/review-progression'
import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import {
	ReviewHandoffSchema,
	mergeOutcomeIdentity,
	type ReviewHandoff,
} from '@humanlayer/riptide-api-contract/lib/review-reporting'
import { afterEach, expect, test, vi } from 'vitest'

import type { ORPCClient } from '@/agents/claudecode/types'
import {
	makeReviewReporting,
	reportDigest,
	reportRequestId,
} from '@/effects/services/review-integration/review-reporting'

import golden from '../fixtures/review-progression-v1.json'

const cleanups: Array<() => Promise<void>> = []
test('paired bridge golden contracts preserve parent, outcome and reverse-ack digests', () => {
	expect(golden.fixtureVersion).toBe(1)
	for (const value of golden.handoffs) {
		const request = ReviewHandoffSchema.parse(value)
		expect(reportRequestId(request)).toBe(value.requestId)
		if (request.kind === 'merge_result')
			expect(reportDigest(mergeOutcomeIdentity(request))).toBe(request.outcomeKey)
		expect(ReviewHandoffSchema.safeParse({ ...value, version: 2 }).success).toBe(false)
		expect(ReviewHandoffSchema.safeParse({ ...value, command: 'merge' }).success).toBe(false)
	}
	for (const { acknowledgementDigest, ...fields } of golden.returnAcks) {
		expect(reportDigest(fields)).toBe(acknowledgementDigest)
		expect(fields.requestId).toBe(golden.handoffs[0]!.requestId)
		expect(fields.outcomeKey).not.toBe(golden.handoffs[1]!.outcomeKey)
	}
})
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'passive-review-')))
	await chmod(directory, 0o700)
	cleanups.push(() => rm(directory, { recursive: true, force: true }))
	const snapshot = {
		taskId: '00000000-0000-7000-8000-000000000001',
		sourceSessionId: '00000000-0000-7000-8000-000000000002',
		enrollment: { enrollmentId: 'fixture', returnRouteRef: 'origin' },
		scopeSha256: 'c'.repeat(64),
		verifiedBinding: { repository: 'fixture/project' },
	} as ReviewProgressionSnapshot
	const receipts: ReviewReportReceipt[] = [],
		events = new Map<string, string>(),
		artifacts = new Map<string, string>(),
		acknowledgements: unknown[] = []
	let loseEvent = false,
		loseReceipt = false,
		artifactUnavailable = false,
		rejectAdmission = false
	const api = {
		reviewProgression: {
			reports: vi.fn(async () => ({
				snapshot,
				codingAgentSessionId: 'actual-source-agent',
				outcome: null,
				wakeRevision: '1',
				planningSuspended: false,
				receipts: [...receipts],
			})),
			recordDelivery: vi.fn(async (input) => {
				const content = (input.destinationSlot === 'artifact' ? artifacts : events).get(input.receiptIdentity)
				if (!content || createHash('sha256').update(content).digest('hex') !== input.contentDigest)
					throw new Error('unverified actual destination')
				const receipt = {
					requestId: input.request.requestId,
					outcomeKey: input.request.outcomeKey,
					destinationSlot: input.destinationSlot,
					receiptIdentity: input.receiptIdentity,
					contentDigest: input.contentDigest,
				}
				const old = receipts.find(
					(item) => item.requestId === receipt.requestId && item.destinationSlot === receipt.destinationSlot,
				)
				if (old) expect(old).toEqual(receipt)
				else receipts.push(receipt)
				if (loseReceipt) {
					loseReceipt = false
					throw new Error('lost receipt response')
				}
				return receipt
			}),
		},
		sessions: {
			events: {
				create: vi.fn(async (input) => {
					expect(input).toMatchObject({
						sessionId: snapshot.sourceSessionId,
						codingAgentSessionId: 'actual-source-agent',
						eventType: 'system',
						role: 'system',
					})
					if (events.has(input.eventId)) expect(events.get(input.eventId)).toBe(input.content)
					events.set(input.eventId, input.content)
					if (loseEvent) {
						loseEvent = false
						throw new Error('lost event response')
					}
					return { eventId: input.eventId, transactionId: 1 }
				}),
			},
		},
		artifacts: {
			upsert: vi.fn(async (input) => {
				if (artifactUnavailable) throw new Error('artifact unavailable')
				if (artifacts.has(input.id)) expect(artifacts.get(input.id)).toBe(input.content)
				artifacts.set(input.id, input.content)
				return { artifactId: input.id, transactionId: 1, created: true }
			}),
		},
	}
	const submit = vi.fn(async (value: any) => {
		if (value.kind !== 'return_ack') {
			if (rejectAdmission) throw new Error('capacity')
			return { status: 'pending' }
		}
		expect(
			receipts.some(
				(item) =>
					item.requestId === value.requestId &&
					item.destinationSlot === value.destinationSlot &&
					item.receiptIdentity === value.receiptIdentity &&
					item.contentDigest === value.contentDigest,
			),
		).toBe(true)
		acknowledgements.push(value)
		return { ...value, status: 'acknowledged' }
	})
	const attention = vi.fn()
	const start = () => {
		const manager = makeReviewReporting(
			api as unknown as ORPCClient,
			async () => ({ directory, requiredReturns: ['origin_session', 'artifact'], submit }),
			attention,
		)
		cleanups.push(() => manager.stop())
		return manager
	}
	const retain = async (outcomeKey = 'a'.repeat(64), status = 'delivered') => {
		const fields = {
			version: 1 as const,
			kind: 'readiness' as const,
			enrollmentId: 'fixture',
			outcomeKey,
			repository: 'fixture/project',
			pr: 7,
			headSha: 'b'.repeat(40),
			scopeSha256: snapshot.scopeSha256!,
			evidenceRef: outcomeKey,
		}
		const request: ReviewHandoff = { ...fields, requestId: reportRequestId(fields) }
		await writeFile(join(directory, `${request.requestId}.request.json`), JSON.stringify(request), { mode: 0o600 })
		await writeFile(
			join(directory, `${request.requestId}.result.json`),
			JSON.stringify({
				version: 1,
				transportKey: request.requestId,
				requestId: request.requestId,
				outcomeKey,
				status,
				slackReceipt: status === 'delivered' ? '123.456' : null,
				contentDigest: reportDigest('slack'),
				report: 'Independently inspected readiness evidence; no execution authority.',
			}),
			{ mode: 0o600 },
		)
		return request
	}
	return {
		directory,
		snapshot,
		api,
		receipts,
		events,
		artifacts,
		acknowledgements,
		submit,
		attention,
		retain,
		start,
		faults: (value: {
			loseEvent?: boolean
			loseReceipt?: boolean
			artifactUnavailable?: boolean
			rejectAdmission?: boolean
		}) => {
			loseEvent = value.loseEvent ?? false
			loseReceipt = value.loseReceipt ?? false
			artifactUnavailable = value.artifactUnavailable ?? false
			rejectAdmission = value.rejectAdmission ?? false
		},
	}
}

test('retained older requests survive later outcomes and restart with deterministic passive writes', async () => {
	const f = await fixture(),
		first = await f.retain()
	let manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts).toHaveLength(2)
	expect(f.acknowledgements).toHaveLength(2)
	await manager.stop()
	const second = await f.retain('e'.repeat(64))
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.events.size).toBe(2)
	expect(f.artifacts.size).toBe(2)
	expect(f.receipts.map((item) => item.requestId)).toEqual(
		expect.arrayContaining([first.requestId, second.requestId]),
	)
	expect(f.api.sessions.events.create).toHaveBeenCalledTimes(2)
})

test('lost event and receipt responses retry the same identity without acknowledging unverified writes', async () => {
	const f = await fixture()
	await f.retain()
	f.faults({ loseEvent: true })
	let manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts.map((item) => item.destinationSlot)).toEqual(['artifact'])
	await manager.stop()
	f.faults({ loseReceipt: true })
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts).toHaveLength(2)
	await manager.stop()
	f.faults({})
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.events.size).toBe(1)
	expect(f.artifacts.size).toBe(1)
	expect(f.api.sessions.events.create).toHaveBeenCalledTimes(2)
	expect(f.acknowledgements.some((item: any) => item.destinationSlot === 'origin_session')).toBe(true)
})

test('partial returns remain independent and capacity admission failure does not block controls', async () => {
	const f = await fixture()
	await f.retain()
	f.api.reviewProgression.reports.mockImplementation(async () => ({
		snapshot: f.snapshot,
		codingAgentSessionId: 'actual-source-agent',
		outcome: {
			status: 'needs_decision',
			reason: 'writer_unknown',
			context: null,
			continuation: { kind: 'stop' },
		} as any,
		wakeRevision: '1',
		planningSuspended: false,
		receipts: [...f.receipts],
	}))
	f.faults({ artifactUnavailable: true, rejectAdmission: true })
	const manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts.map((item) => item.destinationSlot)).toEqual(['origin_session'])
	expect(f.acknowledgements).toHaveLength(1)
	f.faults({ rejectAdmission: true })
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts).toHaveLength(2)
	expect(f.events.size).toBe(1)
})

test('unconfirmed Slack readiness is rendered as needs-decision and shutdown stops retries', async () => {
	const f = await fixture()
	await f.retain('a'.repeat(64), 'unknown')
	const manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(JSON.parse([...f.events.values()][0]!).status).toBe('needs_decision')
	await manager.stop()
	const calls = f.api.reviewProgression.reports.mock.calls.length
	await manager.flush(f.snapshot.taskId)
	expect(f.api.reviewProgression.reports).toHaveBeenCalledTimes(calls)
})

test('lost acknowledgement response replays confirmed receipts after restart without rewriting destinations', async () => {
	const f = await fixture()
	await f.retain()
	const submit = f.submit.getMockImplementation()!
	f.submit.mockImplementationOnce(async (value) => {
		await submit(value)
		throw new Error('lost acknowledgement response')
	})
	let manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts).toHaveLength(2)
	await manager.stop()
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.api.sessions.events.create).toHaveBeenCalledTimes(1)
	expect(f.api.artifacts.upsert).toHaveBeenCalledTimes(1)
	expect(f.acknowledgements).toHaveLength(4)
})

test('producer admission requires an actual retained request, not a pending response alone', async () => {
	const f = await fixture(),
		manager = f.start(),
		signal = new AbortController().signal
	const outcome = { status: 'needs_decision', reason: 'operator_required', context: null }
	await expect(manager.retain(f.snapshot, outcome, signal)).rejects.toThrow()
	const request = f.submit.mock.calls[0]![0]
	f.submit.mockImplementation(async (value) => {
		expect(value).toEqual(request)
		await writeFile(join(f.directory, `${value.requestId}.request.json`), JSON.stringify(value), { mode: 0o600 })
		return { status: 'pending' }
	})
	await expect(manager.retain(f.snapshot, outcome, signal)).resolves.toBeUndefined()
	expect(f.events.size).toBe(0)
	expect(f.artifacts.size).toBe(0)
})

test.each(['work_revision', 'planning'] as const)(
	'pre-ack readiness is not freshly submitted after %s; retained old returns still drain',
	async (change) => {
		const f = await fixture()
		const old = await f.retain()
		const state = {
			snapshot: f.snapshot,
			codingAgentSessionId: 'actual-source-agent',
			outcome: null,
			receipts: f.receipts,
			wakeRevision: change === 'work_revision' ? '2' : '1',
			planningSuspended: change === 'planning',
		}
		f.api.reviewProgression.reports.mockImplementation(async () => state)
		const manager = f.start()
		const readiness = {
			status: 'ready_for_human_approval',
			reason: 'verified',
			context: { pr: 7, headSha: 'b'.repeat(40) },
		}
		await manager.retain(f.snapshot, readiness, new AbortController().signal, '1')
		expect(f.submit).not.toHaveBeenCalled()
		f.faults({ artifactUnavailable: true })
		await manager.flush(f.snapshot.taskId)
		expect(f.receipts.map((item) => item.destinationSlot)).toEqual(['origin_session'])
		f.faults({})
		await manager.flush(f.snapshot.taskId)
		expect(f.receipts).toHaveLength(2)
		expect(f.receipts.every((item) => item.requestId === old.requestId)).toBe(true)
		expect(f.submit.mock.calls.every(([value]) => value.kind === 'return_ack')).toBe(true)
		expect(f.events.size).toBe(1)
		expect(f.artifacts.size).toBe(1)
	},
)

test('compacted replay acknowledges only already confirmed destinations and never reconstructs erased reports', async () => {
	const f = await fixture(),
		request = await f.retain()
	let manager = f.start()
	await manager.flush(f.snapshot.taskId)
	await manager.stop()
	const file = join(f.directory, `${request.requestId}.result.json`)
	const { report, ...result } = JSON.parse(await readFile(file, 'utf8'))
	await writeFile(file, JSON.stringify({ ...result, compacted: true, reportDigest: reportDigest(report) }), {
		mode: 0o600,
	})
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.acknowledgements).toHaveLength(4)
	expect(f.api.sessions.events.create).toHaveBeenCalledTimes(1)
	expect(f.api.artifacts.upsert).toHaveBeenCalledTimes(1)
	await manager.stop()
	f.receipts.splice(0)
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.attention).toHaveBeenCalled()
	expect(f.acknowledgements).toHaveLength(4)
	expect(f.api.sessions.events.create).toHaveBeenCalledTimes(1)
	expect(f.api.artifacts.upsert).toHaveBeenCalledTimes(1)
})

async function retainMerge(
	directory: string,
	parent: ReviewHandoff,
	status: 'merged' | 'merge_unknown' | 'observed_external_merge' | 'declined' = 'merged',
) {
	const mergeResult =
		status === 'merged' || status === 'observed_external_merge'
			? { status, headSha: parent.headSha!, mergeCommit: 'd'.repeat(40) }
			: { status, headSha: parent.headSha! }
	const outcomeKey = reportDigest({ kind: 'merge_result', parentRequestId: parent.requestId, result: mergeResult })
	const fields = {
		...parent,
		kind: 'merge_result' as const,
		parentRequestId: parent.requestId,
		mergeResult,
		outcomeKey,
		evidenceRef: outcomeKey,
	}
	const request = ReviewHandoffSchema.parse({ ...fields, requestId: reportRequestId(fields) })
	await writeFile(join(directory, `${request.requestId}.request.json`), JSON.stringify(request), { mode: 0o600 })
	await writeFile(
		join(directory, `${request.requestId}.result.json`),
		JSON.stringify({
			version: 1,
			transportKey: request.requestId,
			requestId: request.requestId,
			outcomeKey,
			status: 'delivered',
			slackReceipt: '124.456',
			contentDigest: reportDigest('merge result'),
			report: JSON.stringify(mergeResult),
		}),
		{ mode: 0o600 },
	)
	return request
}

test('the existing watcher observes a later merge outcome after readiness drains; returns have distinct immutable identities', async () => {
	const f = await fixture(),
		parent = await f.retain(),
		manager = f.start()
	await manager.flush(f.snapshot.taskId)
	const ready = await readFile(join(f.directory, `${parent.requestId}.result.json`), 'utf8')
	const outcome = await retainMerge(f.directory, parent)
	await vi.waitFor(() => expect(f.receipts).toHaveLength(4))
	expect(f.events.size).toBe(2)
	expect(f.artifacts.size).toBe(2)
	expect([...f.events.values()].map((content) => JSON.parse(content).status)).toEqual([
		'ready_for_human_approval',
		'merged',
	])
	expect(
		f.acknowledgements.some(
			(value: any) => value.requestId === outcome.requestId && value.outcomeKey === outcome.outcomeKey,
		),
	).toBe(true)
	expect(await readFile(join(f.directory, `${parent.requestId}.result.json`), 'utf8')).toBe(ready)
	expect(outcome.outcomeKey).not.toBe(parent.outcomeKey)
})

test('unknown and later observed merge reports survive restart with separate acknowledgements and partial returns', async () => {
	const f = await fixture(),
		parent = await f.retain()
	let manager = f.start()
	await manager.flush(f.snapshot.taskId)
	await manager.stop()
	const unknown = await retainMerge(f.directory, parent, 'merge_unknown')
	f.faults({ artifactUnavailable: true })
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(
		f.receipts.filter((item) => item.requestId === unknown.requestId).map((item) => item.destinationSlot),
	).toEqual(['origin_session'])
	await manager.stop()
	const observed = await retainMerge(f.directory, parent, 'observed_external_merge')
	f.faults({})
	manager = f.start()
	await manager.flush(f.snapshot.taskId)
	expect(f.receipts).toHaveLength(6)
	expect(f.events.size).toBe(3)
	expect(f.artifacts.size).toBe(3)
	expect([...f.events.values()].map((content) => JSON.parse(content).status)).toEqual(
		expect.arrayContaining(['merge_unknown', 'observed_external_merge']),
	)
	expect(new Set(f.receipts.map((item) => item.requestId))).toEqual(
		new Set([parent.requestId, unknown.requestId, observed.requestId]),
	)
})

test('closed merge-result contract rejects drift, extra authority and mismatched outcome identities before destination writes', async () => {
	const f = await fixture(),
		parent = await f.retain(),
		request = await retainMerge(f.directory, parent)
	expect(request.kind).toBe('merge_result')
	if (request.kind !== 'merge_result') throw new Error('fixture')
	for (const patch of [
		{ headSha: 'e'.repeat(40) },
		{ run: true },
		{ parentRequestId: null },
		{ mergeResult: { ...request.mergeResult, command: 'merge' } },
	]) {
		expect(ReviewHandoffSchema.safeParse({ ...request, ...patch }).success).toBe(false)
	}
	expect(reportDigest(mergeOutcomeIdentity(request))).toBe(request.outcomeKey)
	const invalid = { ...request, outcomeKey: 'f'.repeat(64), evidenceRef: 'f'.repeat(64) }
	invalid.requestId = reportRequestId(invalid)
	await writeFile(join(f.directory, `${invalid.requestId}.request.json`), JSON.stringify(invalid), { mode: 0o600 })
	await f.start().flush(f.snapshot.taskId)
	expect(f.attention).toHaveBeenCalled()
	expect(f.receipts.every((item) => item.requestId !== invalid.requestId)).toBe(true)
})

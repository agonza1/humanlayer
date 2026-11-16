import { createHash } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { it as effectIt } from '@effect/vitest'
import { reviewProgressionSelectSchema } from '@humanlayer/db/tables/review-progression'
import { ReviewProgressionSnapshotSchema } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import { Deferred, Effect, Fiber, Layer, Sink, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaemonServices } from '@/agents/claudecode/types'
import { createInterruptState } from '@/agents/shared/interrupt-state.service'
import type { SessionContext } from '@/agents/shared/run-session'
import {
	makeManagedReviewProgression,
	observeReviewExecutor,
	type ReviewWriterObservations,
} from '@/effects/services/review-integration/review-integration'
import {
	decodeReviewHelper,
	invokeReviewHelper,
	makeReviewProgressionDispatch,
	strictReviewJson,
	reviewResultDigest,
	type ReviewDispatchClock,
	type ReviewProgressionRow,
} from '@/effects/services/review-integration/review-progression-dispatch'
import type { makeReviewReporting, submitReviewTransport } from '@/effects/services/review-integration/review-reporting'

import golden from '../fixtures/review-progression-v1.json'
import { createTestSession } from '../helpers/session-fixtures'

const id = '01900000-0000-7000-8000-000000000001'
const hash = 'a'.repeat(64)
const placement = {
	kind: 'legacy_directory',
	projectId: null,
	workspaceId: null,
	setupRowId: id,
	workspaceSpecDigest: null,
}
function row(overrides: Partial<ReviewProgressionRow> = {}): ReviewProgressionRow {
	return reviewProgressionSelectSchema.parse({
		task_id: id,
		organization_id: id,
		resource_owner_user_id: 'owner',
		host_id: 'host',
		source_session_id: id,
		enrollment_id: 'personal',
		return_route_ref: 'origin',
		placement,
		accepted_launch_digest: hash,
		accepted_launch: {},
		scope_inputs: {
			task: {
				id,
				name: 'Fictional task',
				slug: 'task',
				project_id: null,
				workspace_id: null,
				resource_owner_user_id: 'owner',
				ticket_id: null,
				ticket_url: null,
				ticket_provider: null,
				ticket_description: null,
				github_connection_id: null,
				ticket_repository_id: null,
				ticket_repository_full_name: null,
			},
			accepted: 'Accepted task',
			artifacts: [
				{
					fileName: 'task.md',
					storageType: 'postgres',
					contentHash: hash,
					contentType: 'text/markdown',
					fileSizeBytes: 13,
					bytesSha256: hash,
				},
			],
			placement,
			repositories: null,
			workspaceSpec: null,
		},
		verified_binding: null,
		binding_digest: null,
		stage: 'awaiting_delivery',
		planning_suspended: false,
		wake_revision: 1n,
		consumed_revision: 0n,
		action_id: null,
		claim_generation: 0n,
		claim_id: null,
		claimed_revision: null,
		claim_expires_at: null,
		continuation: { kind: 'stop' },
		next_wake_at: null,
		verified_pr_binding: null,
		last_outcome: null,
		last_ack: null,
		workflow_mutation_receipts: [],
		writer_receipts: [],
		admitted_execution: null,
		created_at: 0n,
		updated_at: 0n,
		...overrides,
	})
}
const fakeClock: ReviewDispatchClock = {
	now: () => Date.now(),
	set: (delay, callback) => setTimeout(callback, delay),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe('event and deadline review scheduling', () => {
	it('coalesces startup, duplicate sync and lease housekeeping without polling', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const run = vi.fn(async () => {}),
			attention = vi.fn()
		const dispatch = makeReviewProgressionDispatch({ run, attention, clock: fakeClock })
		dispatch.update(row())
		dispatch.update(row())
		await flush()
		dispatch.update(
			row({
				updated_at: 30n,
				claim_generation: 1n,
				claim_id: id,
				claimed_revision: 1n,
				claim_expires_at: 60000n,
			}),
		)
		await vi.advanceTimersByTimeAsync(600_000)
		expect(run).toHaveBeenCalledTimes(1)
		expect(attention).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		await dispatch.stop()
	})
	it('runs a saved 300-second wait exactly at its deadline, not at 30 seconds', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const run = vi.fn(async () => {})
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn(), clock: fakeClock })
		const wait = row({
			consumed_revision: 1n,
			continuation: { kind: 'wait', nextWakeAt: new Date(300_000).toISOString() },
			next_wake_at: 300_000n,
		})
		dispatch.update(wait)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(run).not.toHaveBeenCalled()
		dispatch.update({ ...wait, updated_at: 30000n })
		await vi.advanceTimersByTimeAsync(269_999)
		expect(run).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(run).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(600_000)
		dispatch.update({ ...wait, updated_at: 900_000n })
		await flush()
		expect(run).toHaveBeenCalledTimes(1)
		await dispatch.stop()
	})
	it('retains a completion generation across duplicate and lease-only updates', async () => {
		const run = vi.fn(async () => {})
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn() })
		dispatch.update(row())
		await flush()
		dispatch.writerFinished(id)
		await flush()
		expect(run).toHaveBeenCalledTimes(2)
		dispatch.update(row({ updated_at: 1n, claim_generation: 1n }))
		dispatch.update(row({ updated_at: 2n, claim_generation: 1n }))
		await flush()
		expect(run).toHaveBeenCalledTimes(2)
		await dispatch.stop()
	})
	it('replays an overdue wait once after restart and leaves a stopped continuation inert', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(400_000)
		const run = vi.fn(async () => {}),
			dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn(), clock: fakeClock })
		const wait = row({
			consumed_revision: 1n,
			continuation: { kind: 'wait', nextWakeAt: new Date(300_000).toISOString() },
			next_wake_at: 300_000n,
		})
		dispatch.update(wait)
		await flush()
		dispatch.update(wait)
		await flush()
		expect(run).toHaveBeenCalledTimes(1)
		dispatch.update(row({ consumed_revision: 1n }))
		await vi.advanceTimersByTimeAsync(600_000)
		expect(run).toHaveBeenCalledTimes(1)
		await dispatch.stop()
	})
	it('retains one newer wake during a run and bounds simultaneous work', async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const run = vi.fn(async (_row: ReviewProgressionRow, _signal: AbortSignal) => {
			if (run.mock.calls.length === 1) await pending
		})
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn(), concurrency: 1 })
		dispatch.update(row())
		await flush()
		dispatch.update(row({ wake_revision: 2n }))
		dispatch.update(row({ wake_revision: 3n }))
		await flush()
		expect(run).toHaveBeenCalledTimes(1)
		release()
		await flush()
		expect(run).toHaveBeenCalledTimes(2)
		expect(run.mock.calls[1]![0].wake_revision).toBe(3n)
		await dispatch.stop()
	})
	it('cancels future waits, aborts in-flight helpers and ignores late hints at shutdown', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		let abortObserved = false
		const run = vi.fn(
			(_row, signal: AbortSignal) =>
				new Promise<void>((resolve) =>
					signal.addEventListener(
						'abort',
						() => {
							abortObserved = true
							resolve()
						},
						{ once: true },
					),
				),
		)
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn(), clock: fakeClock })
		dispatch.update(row())
		await flush()
		await dispatch.stop()
		expect(abortObserved).toBe(true)
		dispatch.update(row({ wake_revision: 2n }))
		dispatch.writerFinished(id)
		await vi.advanceTimersByTimeAsync(600_000)
		expect(run).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})
	it('does not retrigger a failed unchanged state or a suspended planning row', async () => {
		const attention = vi.fn(),
			run = vi.fn(async () => {
				throw new Error('unknown')
			})
		const dispatch = makeReviewProgressionDispatch({ run, attention })
		dispatch.update(row())
		await flush()
		dispatch.update(row())
		await flush()
		expect(attention).toHaveBeenCalledTimes(1)
		expect(run).toHaveBeenCalledTimes(1)
		dispatch.update(row({ wake_revision: 2n, planning_suspended: true }))
		await flush()
		expect(run).toHaveBeenCalledTimes(1)
		await dispatch.stop()
	})
	it('ignores a late older claim/ack snapshot without replacing the saved deadline', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const run = vi.fn(async () => {})
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn(), clock: fakeClock })
		dispatch.update(
			row({
				consumed_revision: 1n,
				claim_generation: 2n,
				last_ack: { claimId: id, generation: '2', revision: '1', digest: hash },
				continuation: { kind: 'wait', nextWakeAt: '1970-01-01T00:05:00.000Z' },
				next_wake_at: 300_000n,
			}),
		)
		dispatch.update(row({ claim_generation: 1n }))
		await vi.advanceTimersByTimeAsync(299_999)
		expect(run).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(run).toHaveBeenCalledOnce()
		await dispatch.stop()
	})
	it('aborts deletion but retains the in-flight slot through reinsertion until actual completion', async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		let aborted = false
		const run = vi.fn(async (_row, signal: AbortSignal) => {
			if (run.mock.calls.length === 1) {
				signal.addEventListener('abort', () => {
					aborted = true
				})
				await pending
			}
		})
		const dispatch = makeReviewProgressionDispatch({ run, attention: vi.fn() })
		dispatch.update(row())
		await flush()
		dispatch.remove(id)
		dispatch.update(row({ wake_revision: 2n }))
		await flush()
		expect(aborted).toBe(true)
		expect(run).toHaveBeenCalledOnce()
		release()
		await flush()
		expect(run).toHaveBeenCalledTimes(2)
		await dispatch.stop()
	})
})

describe('closed helper output', () => {
	it('consumes actual helper golden outputs without accepting native identity as managed authority', () => {
		const expected = {
			repository: 'example/product',
			taskId: id,
			scopeSha256: 'aa036335d7a5e952b361fcaf771f963361b4937ad959c8b905c917dcd4e2419e',
			pr: 7,
		}
		for (const value of golden.helperCases) {
			const decode = (output = value.output, code = value.exitCode) =>
				decodeReviewHelper(JSON.stringify(output), code, expected)
			if (value.adapter === 'native') {
				expect(() => decode()).toThrow()
				continue
			}
			expect(decode()).toEqual(value.output)
			expect(() => decode(value.output, value.exitCode === 2 ? 0 : 2)).toThrow()
			expect(() =>
				decodeReviewHelper(JSON.stringify({ ...value.output, outputVersion: 2 }), value.exitCode, expected),
			).toThrow()
		}
	})
	const binding = { repository: 'example/product', taskId: id, scopeSha256: hash, pr: 7, headSha: 'b'.repeat(40) }
	const output = () => ({
		outputVersion: 1,
		context: binding,
		result: {
			status: 'waiting_review',
			reason: 'external_review_pending',
			repository: binding.repository,
			pr: 7,
			task_id: id,
			head_sha: binding.headSha,
			scope_sha256: hash,
		},
		continuation: { kind: 'wait', nextWakeAt: new Date(300_000).toISOString() },
	})
	it('preserves a validated deadline and rejects foreign scope and exit status', () => {
		expect(decodeReviewHelper(JSON.stringify(output()), 0, binding).continuation).toEqual(output().continuation)
		expect(() => decodeReviewHelper(JSON.stringify(output()), 2, binding)).toThrow()
		expect(() =>
			decodeReviewHelper(JSON.stringify(output()), 0, { ...binding, scopeSha256: 'c'.repeat(64) }),
		).toThrow()
		expect(() => decodeReviewHelper(JSON.stringify({ ...output(), command: 'sh' }), 0, binding)).toThrow()
	})
	it.each([
		'{"a":1,"a":2}',
		'{"a":1,"\\u0061":2}',
		'{"a":1e999}',
		'{"a":NaN}',
		'{} {}',
		'[1,]',
		'{"a":undefined}',
		'"unterminated',
		'[[]',
	])('rejects malformed or ambiguous JSON %s', (input) => expect(() => strictReviewJson(input)).toThrow())
	it('bounds size/depth and rejects contradictory machine results', () => {
		expect(() => strictReviewJson(' '.repeat(1_048_577))).toThrow()
		expect(() => strictReviewJson('['.repeat(66) + '0' + ']'.repeat(66))).toThrow()
		expect(() =>
			decodeReviewHelper(JSON.stringify({ ...output(), continuation: { kind: 'stop' } }), 0, binding),
		).toThrow()
		expect(() =>
			decodeReviewHelper(
				JSON.stringify({ ...output(), result: { ...output().result, status: 'waiting_writer' } }),
				0,
				binding,
			),
		).toThrow()
	})
	it('does not promote an unbound blocker into verified readiness', () => {
		const blocker = {
			outputVersion: 1,
			context: null,
			result: { status: 'needs_decision', reason: 'unknown_writer' },
			continuation: { kind: 'stop' },
		}
		expect(decodeReviewHelper(JSON.stringify(blocker), 2, binding).context).toBeNull()
		expect(() =>
			decodeReviewHelper(
				JSON.stringify({ ...blocker, result: { ...blocker.result, verified: true } }),
				2,
				binding,
			),
		).toThrow()
	})
})

describe('bounded fixed helper process capability', () => {
	const input = () =>
		({
			snapshot: { workingDirectory: '/fictional/repo' },
			enrollment: {
				helper: { path: '/fictional/development_review.py' },
				helperConfig: { path: '/fictional/static.json' },
			},
			pr: 7,
			operation: 'step',
			apply: false,
			started: vi.fn(),
			exited: vi.fn(),
		}) as unknown as Parameters<typeof invokeReviewHelper>[0]
	function spawner(
		stdout: Stream.Stream<Uint8Array>,
		exit = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
		stderr: Stream.Stream<Uint8Array> = Stream.empty,
	) {
		const seen = vi.fn(),
			finalized = vi.fn()
		const layer = Layer.succeed(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make((command) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						seen(command)
						return ChildProcessSpawner.makeHandle({
							pid: ChildProcessSpawner.ProcessId(123),
							exitCode: exit,
							isRunning: Effect.succeed(false),
							kill: () => Effect.void,
							stdin: Sink.drain,
							stdout,
							stderr,
							all: Stream.empty,
							getInputFd: () => Sink.drain,
							getOutputFd: () => Stream.empty,
							unref: Effect.succeed(Effect.void),
						})
					}),
					() =>
						Effect.sync(() => {
							finalized()
						}),
				),
			),
		)
		return { layer, seen, finalized }
	}
	it('uses only the pinned helper argv and streamed stdin, and observes actual exit', async () => {
		const args = input(),
			process = spawner(Stream.make(new TextEncoder().encode('{"ok":true}')))
		expect(await Effect.runPromise(invokeReviewHelper(args).pipe(Effect.provide(process.layer)))).toEqual({
			stdout: '{"ok":true}',
			exitCode: 0,
		})
		expect(args.started).toHaveBeenCalledWith(123)
		expect(args.exited).toHaveBeenCalledWith(123)
		expect(process.finalized).toHaveBeenCalledOnce()
		expect(process.seen.mock.calls[0]![0]).toMatchObject({
			command: 'python3',
			args: [
				'-B',
				'/fictional/development_review.py',
				'--config',
				'/fictional/static.json',
				'--operation',
				'step',
				'--machine-output',
				'v1',
				'--managed-input',
				'v1',
			],
		})
	})
	it('bounds stdout without logging it and closes the process scope on failure', async () => {
		const process = spawner(Stream.make(new Uint8Array(1_048_577)))
		await expect(
			Effect.runPromise(invokeReviewHelper(input()).pipe(Effect.provide(process.layer))),
		).rejects.toThrow('review_helper_state_unknown')
		expect(process.finalized).toHaveBeenCalledOnce()
	})
	it.each([65_536, 65_537])('independently caps stderr at 64 KiB: %i bytes', async (size) => {
		const process = spawner(
			Stream.empty,
			Effect.succeed(ChildProcessSpawner.ExitCode(0)),
			Stream.make(new Uint8Array(size)),
		)
		const result = Effect.runPromise(invokeReviewHelper(input()).pipe(Effect.provide(process.layer)))
		if (size === 65_536) await expect(result).resolves.toEqual({ stdout: '', exitCode: 0 })
		else await expect(result).rejects.toThrow('review_helper_state_unknown')
		expect(process.finalized).toHaveBeenCalledOnce()
	})
	it('accepts both independent limits concurrently rather than charging stderr against stdout', async () => {
		const stdout = 'x'.repeat(1_048_576)
		const process = spawner(
			Stream.make(new TextEncoder().encode(stdout)),
			Effect.succeed(ChildProcessSpawner.ExitCode(0)),
			Stream.make(new Uint8Array(65_536)),
		)
		await expect(
			Effect.runPromise(invokeReviewHelper(input()).pipe(Effect.provide(process.layer))),
		).resolves.toEqual({ stdout, exitCode: 0 })
		expect(process.finalized).toHaveBeenCalledOnce()
	})
	it('rejects write flags for read-only operations before spawning', async () => {
		const process = spawner(Stream.empty),
			args = { ...input(), operation: 'observe-delivery' as const, apply: true }
		await expect(Effect.runPromise(invokeReviewHelper(args).pipe(Effect.provide(process.layer)))).rejects.toThrow()
		expect(process.seen).not.toHaveBeenCalled()
	})
	effectIt.effect('times out at 120 seconds and releases the handle without inventing exit evidence', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const args = input()
			const process = spawner(
				Stream.empty,
				Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
			)
			const fiber = yield* Effect.forkChild(
				Effect.flip(invokeReviewHelper(args).pipe(Effect.provide(process.layer))),
			)
			yield* Deferred.await(started)
			yield* TestClock.adjust('119 seconds')
			expect(process.finalized).not.toHaveBeenCalled()
			yield* TestClock.adjust('1 second')
			expect((yield* Fiber.join(fiber)).message).toBe('review_helper_state_unknown')
			expect(process.finalized).toHaveBeenCalledOnce()
			expect(args.exited).not.toHaveBeenCalled()
		}),
	)
})

describe('actual writer and uncertain helper reconciliation', () => {
	function fixture(overrides: Partial<ReviewProgressionRow> = {}) {
		const binding = {
			workingDirectory: '/fictional/repo',
			repositoryDirectory: '/fictional/repo',
			repository: 'example/product',
			branch: 'codex/test',
			helperConfigDigest: hash,
		}
		const hint = row({
			stage: 'reviewing',
			verified_binding: binding,
			binding_digest: reviewResultDigest(binding),
			verified_pr_binding: {
				repository: binding.repository,
				branch: binding.branch,
				pr: 7,
				headSha: 'b'.repeat(40),
				scopeSha256: hash,
				sourceSessionId: id,
			},
			last_ack: { claimId: id, generation: '1', revision: '0', digest: hash },
			...overrides,
		})
		const snapshot = ReviewProgressionSnapshotSchema.parse({
			taskId: id,
			sourceSessionId: id,
			executionSessionId: id,
			organizationId: id,
			ownerUserId: 'owner',
			hostId: 'host',
			enrollment: { enrollmentId: 'personal', returnRouteRef: 'origin' },
			placement: hint.placement,
			acceptedLaunchDigest: hash,
			executionDigest: hash,
			scopeInputs: hint.scope_inputs,
			sourceCreatedAtMs: 0,
			scopeSha256: hash,
			workingDirectory: binding.workingDirectory,
			repositories: null,
			workspaceSpec: null,
			setupComplete: true,
			verifiedBinding: binding,
			bindingDigest: reviewResultDigest(binding),
		})
		const claim = vi.fn(
			async (
				_input: Parameters<DaemonServices['orpc']['reviewProgression']['claim']>[0],
				_options?: unknown,
			) => ({
				kind: 'claimed',
				generation: '2',
				claimedRevision: '1',
				expiresAt: '60000',
				reconciliationRequired: true,
				snapshot,
				prBinding: hint.verified_pr_binding,
			}),
		)
		const ack = vi.fn(
			async (_input: Parameters<DaemonServices['orpc']['reviewProgression']['ack']>[0], _options?: unknown) => ({
				acknowledged: true,
			}),
		)
		const recordDelivery = vi.fn(
			async (
				input: Parameters<DaemonServices['orpc']['reviewProgression']['recordDelivery']>[0],
				_options?: unknown,
			) => ('kind' in input ? {} : input.binding),
		)
		const update = vi.fn(async () => ({}))
		const observations: ReviewWriterObservations = { runs: new Map() }
		const services = {
			reviewWriterObservations: observations,
			collections: {
				sessions: {
					toArray: [
						createTestSession({ id, task_id: id, status: 'ready_for_input', execution_phase: 'review' }),
					],
				},
				reviewProgression: { toArray: [hint] },
			},
			orpc: {
				sessions: { update },
				reviewProgression: {
					admission: async () => ({ kind: 'not_enrolled' }),
					claim,
					ack,
					recordDelivery,
					renew: vi.fn(async () => ({ expiresAt: '80000' })),
				},
			},
			daemonRuntime: { runPromise: Effect.runPromise },
		} as unknown as DaemonServices
		const context = {
			repository: binding.repository,
			taskId: id,
			scopeSha256: hash,
			pr: 7,
			headSha: 'b'.repeat(40),
		}
		const invoke = vi.fn((args: Parameters<typeof invokeReviewHelper>[0]) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context,
						result: {
							status: 'waiting_review',
							reason: 'external_review_pending',
							repository: binding.repository,
							pr: 7,
							task_id: id,
							head_sha: context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'wait', nextWakeAt: '1970-01-01T00:05:00.000Z' },
					}),
					exitCode: 0,
				}
			}),
		)
		const actualWriters = vi.fn(async () => new Set<string>())
		const retainReport = vi.fn<ReturnType<typeof makeReviewReporting>['retain']>(async () => {})
		const load = vi.fn(async () => ({}) as Parameters<typeof invokeReviewHelper>[0]['enrollment'])
		const submitReport = vi.fn<typeof submitReviewTransport>()
		const dispatch = makeManagedReviewProgression(services, {
			clock: fakeClock,
			actualWriters,
			invoke,
			retainReport,
			load,
			submitReport,
			verify: vi.fn(async () => binding),
			prepare: vi.fn(async () => {}),
			verifyArtifacts: vi.fn(async () => {}),
		})
		return {
			dispatch,
			hint,
			claim,
			ack,
			recordDelivery,
			update,
			invoke,
			observations,
			services,
			actualWriters,
			context,
			retainReport,
			snapshot,
			load,
			submitReport,
		}
	}
	const settle = async () => {
		for (let i = 0; i < 10; i++) await flush()
	}
	it('reports typed writer uncertainty before any helper outcome through the existing independent returns', async () => {
		const test = fixture({ action_id: id })
		const original = { taskId: id, identity: hash, running: false, uncertain: true }
		test.observations.runs.set(id, original)
		const directory = await realpath(await mkdtemp(join(tmpdir(), 'coordinator-report-')))
		await chmod(directory, 0o700)
		try {
			const bytes = '// fictional pinned submitter'
			const submitter = {
				path: join(directory, 'submitter.js'),
				digest: createHash('sha256').update(bytes).digest('hex'),
			}
			await writeFile(submitter.path, bytes, { mode: 0o600 })
			const bridge = {
				version: 1,
				kind: 'review_bridge_binding',
				organizationId: id,
				ownerUserId: 'owner',
				hostId: 'host',
				returnRouteRefs: ['origin'],
				transport: {
					version: 1,
					inboxDirectory: directory,
					enrollments: [
						{
							enrollmentId: 'personal',
							returnRouteRef: 'origin',
							repository: 'example/product',
							scopeSha256: hash,
							helperPath: '/fictional/helper',
							helperDigest: hash,
							helperConfigPath: '/fictional/config',
							helperConfigDigest: hash,
							slack: {
								appId: 'AFIXTURE',
								workspaceId: 'TFIXTURE',
								channelId: 'CFIXTURE',
								ownerUserId: 'UFIXTURE',
								surface: 'channel',
							},
							requiredReturns: ['origin_session', 'artifact'],
						},
					],
				},
			}
			const configuration = {
				path: join(directory, 'bridge.json'),
				digest: createHash('sha256').update(JSON.stringify(bridge)).digest('hex'),
			}
			await writeFile(configuration.path, JSON.stringify(bridge), { mode: 0o600 })
			test.load.mockResolvedValue({
				organizationId: id,
				ownerUserId: 'owner',
				hostId: 'host',
				bridge: { submitter, configuration, returnRouteRefs: ['origin'] },
			} as never)
			const receipts: any[] = []
			const reports = vi.fn(async () => ({
				snapshot: test.snapshot,
				codingAgentSessionId: 'actual-origin',
				outcome: null,
				wakeRevision: '1',
				planningSuspended: false,
				receipts: [...receipts],
			}))
			Object.assign(test.services.orpc.reviewProgression, { reports })
			const event = vi.fn(async (_input: { content: string }) => ({}))
			Object.assign(test.services.orpc.sessions, { events: { create: event } })
			const artifact = vi.fn(async (input) => ({ artifactId: input.id }))
			Object.assign(test.services.orpc, { artifacts: { upsert: artifact } })
			test.recordDelivery.mockImplementation(async (input) => {
				if (!('kind' in input)) throw new Error('No helper delivery is permitted')
				const receipt = {
					requestId: input.request.requestId,
					outcomeKey: input.request.outcomeKey,
					destinationSlot: input.destinationSlot,
					receiptIdentity: input.receiptIdentity,
					contentDigest: input.contentDigest,
				}
				receipts.push(receipt)
				return receipt as never
			})
			test.submitReport.mockImplementation(async (_path, _env, value: any) => {
				if (value.kind === 'return_ack') return { ...value, status: 'acknowledged' }
				expect(value).toMatchObject({ kind: 'blocker', pr: null, headSha: null })
				await writeFile(join(directory, `${value.requestId}.request.json`), JSON.stringify(value), {
					mode: 0o600,
				})
				await writeFile(
					join(directory, `${value.requestId}.result.json`),
					JSON.stringify({
						version: 1,
						transportKey: value.requestId,
						requestId: value.requestId,
						outcomeKey: value.outcomeKey,
						status: 'delivered',
						slackReceipt: '123.456',
						contentDigest: hash,
						report: 'Writer cleanup is unknown. No replacement has started.',
					}),
					{ mode: 0o600 },
				)
				return { status: 'pending' }
			})
			const before = structuredClone(test.hint)
			test.dispatch.update(test.hint)
			await vi.waitFor(() => expect(receipts).toHaveLength(2))
			expect(JSON.parse(event.mock.calls[0]![0].content).status).toBe('needs_decision')
			expect(artifact).toHaveBeenCalledOnce()
			test.dispatch.update(test.hint)
			await settle()
			expect(test.submitReport.mock.calls.filter(([, , value]: any) => value.kind !== 'return_ack')).toHaveLength(
				1,
			)
			expect(event).toHaveBeenCalledOnce()
			expect(receipts.map((receipt) => receipt.destinationSlot).sort()).toEqual(['artifact', 'origin_session'])
			expect(test.claim).not.toHaveBeenCalled()
			expect(test.invoke).not.toHaveBeenCalled()
			expect(test.ack).not.toHaveBeenCalled()
			expect(test.hint).toEqual(before)
			expect(test.observations.runs.get(id)).toBe(original)
		} finally {
			await test.dispatch.stop()
			await rm(directory, { recursive: true, force: true })
		}
	})
	it('retains a bridge intent before outcome acknowledgement and retries admission without another helper', async () => {
		const test = fixture()
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context: test.context,
						result: { status: 'needs_decision', reason: 'operator_required' },
						continuation: { kind: 'stop' },
					}),
					exitCode: 2,
				}
			}),
		)
		test.retainReport.mockRejectedValueOnce(new Error('admission full'))
		test.dispatch.update(test.hint)
		await settle()
		expect(test.ack).not.toHaveBeenCalled()
		expect(test.invoke).toHaveBeenCalledOnce()
		test.dispatch.update({ ...test.hint, wake_revision: 2n })
		await settle()
		expect(test.retainReport).toHaveBeenCalledTimes(2)
		expect(test.ack).toHaveBeenCalledOnce()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.retainReport.mock.calls[0]!.slice(0, 2)).toEqual(test.retainReport.mock.calls[1]!.slice(0, 2))
		expect(test.retainReport.mock.invocationCallOrder[1]).toBeLessThan(test.ack.mock.invocationCallOrder[0]!)
		await test.dispatch.stop()
	})
	it('keeps a prior claim identity even after expiry and never invokes a replacement', async () => {
		const test = fixture({ claim_id: id, claimed_revision: 1n, claim_expires_at: 1n })
		test.dispatch.update(test.hint)
		await settle()
		expect(test.claim).not.toHaveBeenCalled()
		expect(test.invoke).not.toHaveBeenCalled()
		expect(test.ack).not.toHaveBeenCalled()
		expect(test.hint.claim_id).toBe(id)
		expect(test.update).toHaveBeenCalledOnce()
		await test.dispatch.stop()
	})
	it('retains an unknown action despite idle rows and a historical acknowledgement', async () => {
		const test = fixture({ action_id: '01900000-0000-7000-8000-000000000002' })
		test.dispatch.update(test.hint)
		await settle()
		expect(test.claim).not.toHaveBeenCalled()
		expect(test.invoke).not.toHaveBeenCalled()
		expect(test.ack).not.toHaveBeenCalled()
		expect(test.hint.action_id).not.toBeNull()
		await test.dispatch.stop()
	})
	it('allows only a read-only wait observation while actual runtime evidence reports an active writer', async () => {
		const test = fixture()
		test.actualWriters.mockResolvedValue(new Set([id]))
		test.dispatch.update(test.hint)
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.invoke.mock.calls[0]![0].apply).toBe(false)
		expect(test.ack).toHaveBeenCalledOnce()
		expect(test.recordDelivery).not.toHaveBeenCalled()
		await test.dispatch.stop()
	})
	it.each(['running', 'ready_for_launch', 'ready_for_input'] as const)(
		'establishes and expires the initial source deadline for %s without apply, delivery or replacement',
		async (status) => {
			vi.useFakeTimers()
			vi.setSystemTime(0)
			const test = fixture({ verified_pr_binding: null, last_ack: null, stage: 'awaiting_delivery' })
			test.services.collections.sessions.toArray[0]!.status = status
			const active = status !== 'ready_for_launch'
			test.actualWriters.mockResolvedValue(new Set(active ? [id] : []))
			const observation = { taskId: id, identity: hash, running: true, uncertain: true }
			if (active) test.observations.runs.set(id, observation)
			const generations = new Map<string, string>()
			test.claim.mockImplementation(async (input) => {
				if (!generations.has(input.claimId)) generations.set(input.claimId, String(generations.size + 2))
				return {
					kind: 'claimed',
					generation: generations.get(input.claimId)!,
					claimedRevision: input.expectedWakeRevision,
					expiresAt: String(Date.now() + 60_000),
					reconciliationRequired: true,
					snapshot: test.snapshot,
					prBinding: null,
				}
			})
			test.invoke.mockImplementation((args) =>
				Effect.sync(() => {
					args.started(123)
					args.exited(123)
					const expired = fakeClock.now() >= 300_000
					return {
						stdout: JSON.stringify({
							outputVersion: 1,
							context: { ...test.context, pr: null, headSha: null },
							result: {
								status: expired ? 'needs_decision' : 'waiting_writer',
								reason: expired ? 'initial_delivery_deadline_expired' : 'initial_delivery_in_progress',
							},
							continuation: expired
								? { kind: 'stop' }
								: { kind: 'wait', nextWakeAt: '1970-01-01T00:05:00.000Z', actionId: id },
						}),
						exitCode: expired ? 2 : 0,
					}
				}),
			)
			test.ack.mockImplementation(async (input) => {
				const continuation = input.validatedOutcome.continuation
				Object.assign(test.hint, {
					consumed_revision: BigInt(input.claimedRevision),
					claim_generation: BigInt(input.generation),
					continuation,
					next_wake_at: continuation.kind === 'wait' ? BigInt(Date.parse(continuation.nextWakeAt)) : null,
					action_id: id,
					last_outcome: input.validatedOutcome,
					last_ack: {
						claimId: input.claimId,
						generation: input.generation,
						revision: input.claimedRevision,
						digest: input.resultDigest,
					},
				})
				test.dispatch.update(test.hint)
				return { acknowledged: true }
			})
			test.dispatch.update(test.hint)
			await settle()
			expect(test.invoke).toHaveBeenCalledOnce()
			expect(test.hint).toMatchObject({ next_wake_at: 300_000n, consumed_revision: 1n, action_id: id })
			await vi.advanceTimersByTimeAsync(299_999)
			expect(test.invoke).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(1)
			await settle()
			expect(test.invoke).toHaveBeenCalledTimes(2)
			expect(test.ack).toHaveBeenCalledTimes(2)
			expect(test.hint.last_outcome).toMatchObject({ status: 'needs_decision', continuation: { kind: 'stop' } })
			expect(test.update).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(600_000)
			expect(test.invoke).toHaveBeenCalledTimes(2)
			expect(test.invoke.mock.calls.every(([args]) => !args.apply && args.operation === 'observe-delivery')).toBe(
				true,
			)
			expect(test.recordDelivery).not.toHaveBeenCalled()
			if (active) expect(test.observations.runs.get(id)).toEqual(observation)
			expect(vi.getTimerCount()).toBe(0)
			await test.dispatch.stop()
		},
	)
	it('does not apply a read-only writer plan while an actual writer remains active', async () => {
		const test = fixture()
		test.actualWriters.mockResolvedValue(new Set([id]))
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context: test.context,
						result: {
							status: 'plan_qa',
							reason: 'review_required',
							repository: test.context.repository,
							pr: 7,
							task_id: id,
							head_sha: test.context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'stop' },
					}),
					exitCode: 0,
				}
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.invoke.mock.calls[0]![0].apply).toBe(false)
		expect(test.ack).not.toHaveBeenCalled()
		expect(test.recordDelivery).not.toHaveBeenCalled()
		expect(test.update).toHaveBeenCalledOnce()
		await test.dispatch.stop()
	})
	it('replays a lost claim and acknowledgement with the same identities and runs only one read-only wait observation', async () => {
		const test = fixture()
		test.claim.mockRejectedValueOnce(new Error('lost claim response'))
		test.ack.mockRejectedValueOnce(new Error('lost ack response'))
		test.dispatch.update(test.hint)
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.invoke.mock.calls[0]![0].apply).toBe(false)
		expect(test.claim.mock.calls[0]).toEqual(test.claim.mock.calls[1])
		expect(test.ack).toHaveBeenCalledTimes(2)
		expect(test.ack.mock.calls[0]).toEqual(test.ack.mock.calls[1])
		await test.dispatch.stop()
	})
	it('initializes an explicitly planned journal wait and acknowledges only its saved deadline', async () => {
		const test = fixture()
		test.invoke.mockImplementationOnce((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context: test.context,
						result: {
							status: 'plan_qa',
							reason: 'review_wait_requires_journal',
							repository: test.context.repository,
							pr: 7,
							task_id: id,
							head_sha: test.context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'stop' },
					}),
					exitCode: 0,
				}
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		expect(test.invoke.mock.calls.map(([args]) => args.apply)).toEqual([false, true])
		expect(test.ack).toHaveBeenCalledOnce()
		expect(test.ack.mock.calls[0]![0].validatedOutcome).toMatchObject({
			status: 'waiting_review',
			continuation: { kind: 'wait', nextWakeAt: '1970-01-01T00:05:00.000Z' },
		})
		await test.dispatch.stop()
	})
	it('waits for the actual executor promise, marks failures uncertain and emits only a completion hint', async () => {
		let complete!: () => void
		const done = new Promise<void>((resolve) => {
			complete = resolve
		})
		const observations: ReviewWriterObservations = { runs: new Map(), finished: vi.fn() }
		const execute = observeReviewExecutor(async () => done, observations)
		const context: SessionContext = {
			session: createTestSession({ id, task_id: id, status: 'ready_for_input' }),
			services: fixture().services,
			interruptState: await createInterruptState(),
		}
		const running = execute(context)
		await flush()
		expect(observations.runs.get(id)?.running).toBe(true)
		expect(observations.finished).not.toHaveBeenCalled()
		complete()
		await running
		expect(observations.runs.get(id)).toMatchObject({ running: false, uncertain: false })
		expect(observations.finished).toHaveBeenCalledWith(id)
		await expect(
			observeReviewExecutor(async () => {
				throw new Error('unknown process')
			}, observations)(context),
		).rejects.toThrow()
		expect(observations.runs.get(id)).toMatchObject({ running: false, uncertain: true })
	})
	it.each(['codelayer', 'fold'] as const)(
		'retains %s cleanup uncertainty after a successful executor promise and blocks progression',
		async (coding_agent) => {
			const test = fixture({ verified_pr_binding: null, last_ack: null })
			const session = test.services.collections.sessions.toArray[0]
			if (!session) throw new Error('Expected fixture session')
			session.coding_agent = coding_agent
			await observeReviewExecutor(async () => {}, test.observations)({
				session,
				services: test.services,
				interruptState: await createInterruptState(),
			})
			expect(test.observations.runs.get(session.id)).toMatchObject({ running: false, uncertain: true })
			test.dispatch.update(test.hint)
			await settle()
			expect(test.claim).not.toHaveBeenCalled()
			expect(test.invoke).not.toHaveBeenCalled()
			expect(test.services.orpc.sessions.update).toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: expect.stringContaining('no replacement has started') }),
			)
			await test.dispatch.stop()
		},
	)
	it('does not mistake supervised registration for actual writer completion', async () => {
		const observations: ReviewWriterObservations = { runs: new Map(), finished: vi.fn() }
		const context: SessionContext = {
			session: createTestSession({ id, task_id: id, status: 'ready_for_input' }),
			services: fixture().services,
			interruptState: await createInterruptState(),
		}
		await observeReviewExecutor(async () => {}, observations, true)(context)
		expect(observations.runs.get(id)).toMatchObject({ running: true, uncertain: false })
		expect(observations.finished).not.toHaveBeenCalled()
		await observeReviewExecutor(async () => {}, observations, true)(context)
		expect(observations.runs.get(id)).toMatchObject({ running: true, uncertain: true })
	})
	it('retains malformed helper identity and never invokes another helper after a later semantic wake', async () => {
		const test = fixture()
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(456)
				args.exited(456)
				return { stdout: '{"outputVersion":1,"outputVersion":2}', exitCode: 0 }
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		test.dispatch.update({ ...test.hint, wake_revision: 2n })
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.ack).not.toHaveBeenCalled()
		await test.dispatch.stop()
	})
	it('retries a pending acknowledgement before any fresh claim or helper after two lost responses', async () => {
		const test = fixture()
		test.ack.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost again'))
		test.dispatch.update(test.hint)
		await settle()
		const claims = test.claim.mock.calls.length
		test.dispatch.update({ ...test.hint, wake_revision: 2n })
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.claim).toHaveBeenCalledTimes(claims)
		expect(test.ack).toHaveBeenCalledTimes(3)
		expect(test.ack.mock.calls[2]![0]).toEqual(test.ack.mock.calls[0]![0])
		await test.dispatch.stop()
	})
	it('settles a completed retained action before allowing another writer request', async () => {
		const context = { repository: 'example/product', taskId: id, scopeSha256: hash, pr: 7, headSha: 'b'.repeat(40) }
		const test = fixture({
			action_id: id,
			last_outcome: {
				status: 'reviewed',
				reason: 'qa_complete',
				context,
				continuation: { kind: 'reconcile', progressKey: hash },
			},
		})
		const session = test.services.collections.sessions.toArray[0]
		if (!session) throw new Error('Expected fixture session')
		await observeReviewExecutor(async () => {}, test.observations)({
			session,
			services: test.services,
			interruptState: await createInterruptState(),
		})
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context,
						result: {
							status: 'plan_coder',
							reason: 'repair_required',
							repository: context.repository,
							pr: 7,
							task_id: id,
							head_sha: context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'stop' },
					}),
					exitCode: 0,
				}
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.invoke.mock.calls[0]![0].apply).toBe(false)
		expect(test.ack.mock.calls[0]![0].validatedOutcome).toMatchObject({
			status: 'reviewed',
			reason: 'retained_action_reconciled',
			continuation: { kind: 'reconcile' },
		})
		await test.dispatch.stop()
	})
	it('replays delivery recording before ack after response loss without another helper or claim', async () => {
		const test = fixture({ verified_pr_binding: null, last_ack: null })
		const session = test.services.collections.sessions.toArray[0]
		if (!session) throw new Error('Expected fixture session')
		await observeReviewExecutor(async () => {}, test.observations)({
			session,
			services: test.services,
			interruptState: await createInterruptState(),
		})
		test.recordDelivery.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost again'))
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context: test.context,
						result: {
							status: 'delivery_observed',
							reason: 'verified_publication',
							repository: test.context.repository,
							pr: 7,
							task_id: id,
							head_sha: test.context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'stop' },
					}),
					exitCode: 0,
				}
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		expect(test.recordDelivery).toHaveBeenCalledTimes(2)
		expect(test.ack).not.toHaveBeenCalled()
		const claims = test.claim.mock.calls.length
		test.dispatch.update({ ...test.hint, wake_revision: 2n })
		await settle()
		expect(test.recordDelivery).toHaveBeenCalledTimes(3)
		expect(test.recordDelivery.mock.calls[2]![0]).toEqual(test.recordDelivery.mock.calls[0]![0])
		expect(test.ack).toHaveBeenCalledOnce()
		expect(test.invoke).toHaveBeenCalledOnce()
		expect(test.claim).toHaveBeenCalledTimes(claims)
		await test.dispatch.stop()
	})
	it('stops an identical immediate progress key rather than rescheduling it forever', async () => {
		const test = fixture({ continuation: { kind: 'reconcile', progressKey: hash } })
		test.invoke.mockImplementation((args) =>
			Effect.sync(() => {
				args.started(123)
				args.exited(123)
				return {
					stdout: JSON.stringify({
						outputVersion: 1,
						context: test.context,
						result: {
							status: 'reviewed',
							reason: 'qa_complete',
							repository: test.context.repository,
							pr: 7,
							task_id: id,
							head_sha: test.context.headSha,
							scope_sha256: hash,
						},
						continuation: { kind: 'reconcile', progressKey: hash },
					}),
					exitCode: 0,
				}
			}),
		)
		test.dispatch.update(test.hint)
		await settle()
		expect(test.ack.mock.calls[0]![0].validatedOutcome).toMatchObject({
			status: 'needs_decision',
			reason: 'review_progress_did_not_advance',
			continuation: { kind: 'stop' },
		})
		await test.dispatch.stop()
	})
})

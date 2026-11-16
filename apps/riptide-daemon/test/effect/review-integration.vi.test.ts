import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import {
	canonicalReviewValue,
	reviewExecutionPayload,
	type ReviewExecutionSession,
	reviewHelperScope,
	reviewDeliveryContext,
	reviewDeliveryContextFile,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { Effect, Fiber, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { ORPCClient } from '@/agents/claudecode/types'
import type { DaemonServices } from '@/agents/claudecode/types'
import { ClaudeSessions } from '@/effects/services/claude-sessions/claude-sessions.service'
import {
	admitReviewSession,
	checkReviewSessionLaunch,
	observeReviewExecutor,
	type ReviewWriterObservations,
	ReviewLocalEnrollmentSchema,
	ReviewStaticHelperConfigSchema,
	ReviewBridgeBindingSchema,
	type ReviewLocalEnrollment,
	verifyReviewPlacement,
	verifyReviewArtifacts,
	prepareReviewSessionArtifacts,
} from '@/effects/services/review-integration/review-integration'
import type { TaskDiffCollectionLifecycle } from '@/effects/services/task-diff/task-diff-collection-lifecycle'
import { WorkspaceSessionRunnerLive } from '@/effects/services/workspace-session-launch/workspace-session-runner.layer'
import { WorkspaceSessionRunner } from '@/effects/services/workspace-session-launch/workspace-session-runner.service'
import { handleContinueSession } from '@/handlers/sessions/on-session-continue'
import { handleLaunchSession } from '@/handlers/sessions/on-session-launch'
import { makeLegacySessionLaunchExecutorLive, processTaskChange } from '@/subscriptions'

import { createMockDaemonServices } from '../helpers/create-mock-daemon-services'
import { createTestSession } from '../helpers/session-fixtures'
import { createMockORPCClient } from '../mocks/orpc-client.mock'

const isolatedPaths = vi.hoisted(() => ({
	config: '/fictional/unavailable/config',
	artifacts: '/fictional/unavailable/artifacts',
}))
vi.mock('@/lib/config', async (original) => ({
	...(await original<typeof import('@/lib/config')>()),
	getCanonicalConfigPath: () => isolatedPaths.config,
}))
vi.mock('@/lib/artifact-paths', async (original) => ({
	...(await original<typeof import('@/lib/artifact-paths')>()),
	getArtifactStoragePath: () => isolatedPaths.artifacts,
}))

const id = '01900000-0000-7000-8000-000000000001'
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewValue(value)).digest('hex')
const bytesHash = (value: string) => createHash('sha256').update(value).digest('hex')
const binding = {
	workingDirectory: '/fictional/repo',
	repositoryDirectory: '/fictional/repo',
	repository: 'example/product',
	branch: 'codex/test',
	helperConfigDigest: 'a'.repeat(64),
}
const staticConfig = () => ({
	version: 1,
	options: {
		humanlayer_cli: ['humanlayer'],
		reviewers: ['fictional-reviewer'],
		lock_dir: '/fictional/locks',
		auto_repair: false,
		technical_review_receipts: false,
		notify_ready: false,
		review_source: 'local',
		review_wait_seconds: 300,
	},
})
const bridgeConfig = () => ({
	version: 1,
	kind: 'review_bridge_binding',
	organizationId: id,
	ownerUserId: 'owner',
	hostId: 'host',
	returnRouteRefs: ['origin'],
})
const execution = (): ReviewExecutionSession => ({
	id,
	task_id: id,
	organization_id: id,
	created_by: 'owner',
	resource_owner_user_id: 'owner',
	host_id: 'host',
	status: 'ready_for_launch',
	archived: false,
	working_directory: binding.workingDirectory,
	prompt: 'Accepted task',
	coding_agent: 'codelayer',
	coding_agent_session_id: null,
	provider: 'codex',
	model: 'fixture',
	effort: null,
	fast_mode: false,
	permissions_mode: 'default',
	workflow_type: null,
	forked_from_session_id: null,
	handoff_source_session_id: null,
	fork_data: null,
	execution_phase: 'implementation',
	execution_phase_at: null,
})
const scopeInputs = () => ({
	task: {
		id,
		name: 'Delivery',
		slug: 'delivery',
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
			storageType: 'postgres' as const,
			contentHash: 'fixture-hash',
			contentType: 'text/markdown',
			fileSizeBytes: 13,
			bytesSha256: bytesHash('Accepted task'),
		},
	],
	placement: {
		kind: 'legacy_directory' as const,
		projectId: null,
		workspaceId: null,
		setupRowId: id,
		workspaceSpecDigest: null,
	},
	repositories: null,
	workspaceSpec: null,
})
const snapshot = (): ReviewProgressionSnapshot => ({
	taskId: id,
	sourceSessionId: id,
	organizationId: id,
	ownerUserId: 'owner',
	hostId: 'host',
	enrollment: { enrollmentId: 'personal', returnRouteRef: 'origin' },
	placement: {
		kind: 'legacy_directory',
		projectId: null,
		workspaceId: null,
		setupRowId: id,
		workspaceSpecDigest: null,
	},
	acceptedLaunchDigest: 'b'.repeat(64),
	executionDigest: hash(reviewExecutionPayload(execution())),
	workingDirectory: binding.workingDirectory,
	repositories: null,
	workspaceSpec: null,
	setupComplete: true,
	verifiedBinding: null,
	bindingDigest: null,
	scopeInputs: scopeInputs(),
	sourceCreatedAtMs: 1720000000000,
	scopeSha256: null,
})
const local = (): ReviewLocalEnrollment => ({
	organizationId: id,
	ownerUserId: 'owner',
	hostId: 'host',
	projectIds: [],
	placements: ['legacy_directory'],
	repositories: ['example/product'],
	roots: ['/fictional'],
	helper: { path: '/fictional/helper', digest: 'a'.repeat(64) },
	helperConfig: { path: '/fictional/config', digest: binding.helperConfigDigest },
	bridge: {
		submitter: { path: '/fictional/submitter', digest: 'a'.repeat(64) },
		configuration: { path: '/fictional/bridge', digest: 'a'.repeat(64) },
		returnRouteRefs: ['origin'],
	},
	inPlace: [{ directory: binding.repositoryDirectory, repository: binding.repository, branch: binding.branch }],
})

describe('authoritative review launch admission', () => {
	it('permits stock launch only after an authoritative negative enrollment response', async () => {
		const load = vi.fn(async () => local())
		expect(await admitReviewSession(id, createMockORPCClient(), load)).toBe(true)
		expect(load).not.toHaveBeenCalled()
		for (const response of [undefined, {}, { kind: 'not_enrolled', extra: true }]) {
			const api = createMockORPCClient({ reviewProgression: { admission: async () => response as never } })
			await expect(admitReviewSession(id, api, load)).rejects.toThrow()
		}
	})
	it('confirms placement then rereads and reverifies before handoff without relying on a synced collection', async () => {
		const value = snapshot()
		const confirmed = {
			...value,
			verifiedBinding: binding,
			bindingDigest: hash(binding),
			scopeSha256: hash(reviewHelperScope(value.scopeInputs, binding)),
		}
		const admission = vi
			.fn<ORPCClient['reviewProgression']['admission']>()
			.mockResolvedValueOnce({ kind: 'enrolled', snapshot: value })
			.mockResolvedValue({ kind: 'enrolled', snapshot: confirmed })
		const confirmPlacement = vi.fn<ORPCClient['reviewProgression']['confirmPlacement']>().mockResolvedValue(binding)
		const verify = vi.fn(async () => binding)
		const prepare = vi.fn(async () => {}),
			artifacts = vi.fn(async () => {})
		expect(
			await admitReviewSession(
				id,
				createMockORPCClient({ reviewProgression: { admission, confirmPlacement } }),
				async () => local(),
				verify,
				prepare,
				artifacts,
				execution(),
				{ runs: new Map() },
			),
		).toBe(true)
		expect(confirmPlacement).toHaveBeenCalledExactlyOnceWith({
			taskId: id,
			sourceSessionId: id,
			acceptedLaunchDigest: value.acceptedLaunchDigest,
			bindingDigest: hash(binding),
			binding,
		})
		expect(admission).toHaveBeenCalledTimes(3)
		expect(verify).toHaveBeenCalledTimes(3)
		expect(prepare).toHaveBeenCalledExactlyOnceWith(confirmed)
		expect(artifacts).toHaveBeenCalledExactlyOnceWith(confirmed)
	})
	it.each(['source', 'route', 'digest', 'directory', 'setup', 'confirmation'] as const)(
		'rejects changed %s evidence before handoff',
		async (field) => {
			const value = snapshot()
			const again = {
				...value,
				verifiedBinding: binding,
				bindingDigest: hash(binding),
				scopeSha256: hash(reviewHelperScope(value.scopeInputs, binding)),
			}
			if (field === 'source') value.sourceSessionId = '01900000-0000-7000-8000-000000000002'
			if (field === 'route') again.enrollment = { ...again.enrollment, returnRouteRef: 'other' }
			if (field === 'digest') again.acceptedLaunchDigest = 'c'.repeat(64)
			if (field === 'directory') again.workingDirectory = '/other'
			if (field === 'setup') again.setupComplete = false
			const admission = vi
				.fn<ORPCClient['reviewProgression']['admission']>()
				.mockResolvedValueOnce({ kind: 'enrolled', snapshot: value })
				.mockResolvedValueOnce({ kind: 'enrolled', snapshot: again })
			const confirmPlacement = vi
				.fn<ORPCClient['reviewProgression']['confirmPlacement']>()
				.mockResolvedValue(field === 'confirmation' ? { ...binding, branch: 'other' } : binding)
			expect(
				await admitReviewSession(
					id,
					createMockORPCClient({ reviewProgression: { admission, confirmPlacement } }),
					async () => local(),
					async () => binding,
					undefined,
					undefined,
					execution(),
					{ runs: new Map() },
				),
			).toBe(false)
		},
	)
	it('does not launch across artifact synchronization failure, digest substitution or a late authoritative change', async () => {
		const value = snapshot(),
			confirmed = {
				...value,
				verifiedBinding: binding,
				bindingDigest: hash(binding),
				scopeSha256: hash(reviewHelperScope(value.scopeInputs, binding)),
			}
		for (const failure of ['sync', 'bytes', 'late'] as const) {
			const admission = vi
				.fn<ORPCClient['reviewProgression']['admission']>()
				.mockResolvedValueOnce({ kind: 'enrolled', snapshot: value })
				.mockResolvedValueOnce({ kind: 'enrolled', snapshot: confirmed })
				.mockResolvedValue({
					kind: 'enrolled',
					snapshot: { ...confirmed, acceptedLaunchDigest: 'f'.repeat(64) },
				})
			const api = createMockORPCClient({
				reviewProgression: { admission, confirmPlacement: async () => binding },
			})
			const attempt = admitReviewSession(
				id,
				api,
				async () => local(),
				async () => binding,
				async () => {
					if (failure === 'sync') throw new Error('not_synced')
				},
				async () => {
					if (failure === 'bytes') throw new Error('bytes_changed')
				},
				execution(),
				{ runs: new Map() },
			)
			if (failure === 'late') expect(await attempt).toBe(false)
			else await expect(attempt).rejects.toThrow()
		}
	})
	it.each([
		'prompt',
		'working_directory',
		'coding_agent',
		'provider',
		'model',
		'effort',
		'fast_mode',
		'permissions_mode',
		'fork_data',
		'host_id',
		'task_id',
	] as const)('rejects a stale synchronized %s before confirmation or execution', async (field) => {
		const value = snapshot(),
			candidate = { ...execution(), [field]: field === 'fast_mode' ? true : 'stale' }
		const api = createMockORPCClient({
			reviewProgression: { admission: async () => ({ kind: 'enrolled', snapshot: value }) },
		})
		const verify = vi.fn(async () => binding)
		expect(
			await admitReviewSession(
				id,
				api,
				async () => local(),
				verify,
				undefined,
				undefined,
				candidate as ReviewExecutionSession,
				{ runs: new Map() },
			),
		).toBe(false)
		expect(verify).not.toHaveBeenCalled()
	})
	it('rejects candidate mutation while synchronization is awaited', async () => {
		const value = snapshot(),
			candidate = execution(),
			confirmed = {
				...value,
				verifiedBinding: binding,
				bindingDigest: hash(binding),
				scopeSha256: hash(reviewHelperScope(value.scopeInputs, binding)),
			}
		const api = createMockORPCClient({
			reviewProgression: {
				admission: vi
					.fn<ORPCClient['reviewProgression']['admission']>()
					.mockResolvedValueOnce({ kind: 'enrolled', snapshot: value })
					.mockResolvedValue({ kind: 'enrolled', snapshot: confirmed }),
				confirmPlacement: async () => binding,
			},
		})
		expect(
			await admitReviewSession(
				id,
				api,
				async () => local(),
				async () => binding,
				async () => {
					candidate.prompt = 'changed'
				},
				async () => {},
				candidate,
				{ runs: new Map() },
			),
		).toBe(false)
	})
	it('defers unavailable admission, suppresses repeated blocker writes and clears the blocker after recovery', async () => {
		const admission = vi
			.fn<ORPCClient['reviewProgression']['admission']>()
			.mockRejectedValue(new Error('unavailable'))
		const update = vi.fn<ORPCClient['sessions']['update']>().mockResolvedValue({} as never)
		const api = createMockORPCClient({ reviewProgression: { admission }, sessions: { update } })
		expect(await checkReviewSessionLaunch(id, api)).toBe(false)
		expect(await checkReviewSessionLaunch(id, api)).toBe(false)
		expect(update).toHaveBeenCalledTimes(1)
		expect(update.mock.calls[0]?.[0]).toMatchObject({
			sessionId: id,
			errorMessage: expect.stringContaining('No session has started'),
		})
		admission.mockResolvedValue({ kind: 'not_enrolled' })
		expect(await checkReviewSessionLaunch(id, api)).toBe(true)
		expect(update).toHaveBeenLastCalledWith({ sessionId: id, errorMessage: '' })
	})
})

describe('local enrollment and actual checkout verification', () => {
	it.each([
		'running',
		'uncertain',
		'sibling-running',
		'sibling-uncertain',
		'missing',
		'reconstruction',
		'new-source-unknown',
		'identity-task',
		'live',
	] as const)(
		'enforces actual legacy, V2 and continue boundaries for local %s evidence without replacement effects',
		async (kind) => {
			const root = await realpath(await mkdtemp(join(tmpdir(), 'review-local-gate-')))
			const services = createMockDaemonServices()
			const exec = promisify(execFile)
			try {
				await exec('git', ['-C', root, 'init', '-b', binding.branch])
				await exec('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/product.git'])
				const configBytes = JSON.stringify(staticConfig()),
					bridgeBytes = JSON.stringify(bridgeConfig())
				const pinned = { path: join(root, 'helper'), digest: bytesHash(configBytes) }
				const bridge = { path: join(root, 'bridge'), digest: bytesHash(bridgeBytes) }
				await writeFile(pinned.path, configBytes, { mode: 0o600 })
				await writeFile(bridge.path, bridgeBytes, { mode: 0o600 })
				const confirmedBinding = {
					...binding,
					workingDirectory: root,
					repositoryDirectory: root,
					helperConfigDigest: pinned.digest,
				}
				const enrollment = {
					...local(),
					roots: [root],
					helper: pinned,
					helperConfig: pinned,
					bridge: { submitter: pinned, configuration: bridge, returnRouteRefs: ['origin'] },
					inPlace: [{ directory: root, repository: binding.repository, branch: binding.branch }],
				}
				isolatedPaths.config = join(root, 'runtime-config')
				isolatedPaths.artifacts = join(root, 'artifacts')
				await mkdir(isolatedPaths.artifacts)
				await writeFile(
					isolatedPaths.config,
					JSON.stringify({ reviewProgressionEnrollments: { personal: enrollment } }),
					{ mode: 0o600 },
				)
				const session = createTestSession({ ...execution(), working_directory: root })
				if (kind === 'live') {
					session.coding_agent = 'claude'
					session.coding_agent_session_id = 'actual-live-generation'
				}
				const value = {
					...snapshot(),
					workingDirectory: root,
					executionDigest: hash(reviewExecutionPayload(session)),
					verifiedBinding: confirmedBinding,
					bindingDigest: hash(confirmedBinding),
					scopeSha256: hash(reviewHelperScope(scopeInputs(), confirmedBinding)),
				}
				if (kind === 'new-source-unknown') {
					value.sourceSessionId = '01900000-0000-7000-8000-000000000002'
					Object.assign(value, { executionSessionId: id })
				}
				await writeFile(join(isolatedPaths.artifacts, 'task.md'), value.scopeInputs.accepted, { mode: 0o600 })
				await writeFile(
					join(isolatedPaths.artifacts, reviewDeliveryContextFile(id)),
					canonicalReviewValue(reviewDeliveryContext(value)),
					{ mode: 0o600 },
				)
				const original = {
					taskId: kind === 'identity-task' ? '01900000-0000-7000-8000-000000000003' : id,
					identity: 'old-generation',
					running: kind.includes('running') || kind === 'live',
					uncertain: kind.includes('uncertain') || kind === 'live',
				}
				const priorId = kind.startsWith('sibling') ? '01900000-0000-7000-8000-000000000002' : id
				const observations: ReviewWriterObservations = { runs: new Map() }
				if (!['missing', 'reconstruction', 'new-source-unknown'].includes(kind))
					observations.runs.set(priorId, original)
				services.reviewWriterObservations = kind === 'missing' ? undefined : observations
				if (kind === 'reconstruction') session.status = 'resuming'
				services.collections.sessions = {
					toArray: [session],
				} as unknown as DaemonServices['collections']['sessions']
				services.collections.tasks = {
					toArray: [{ id, workspace_spec: null }],
				} as unknown as DaemonServices['collections']['tasks']
				const update = vi.fn<ORPCClient['sessions']['update']>(async () => ({
					success: true,
					transactionId: 'fixture',
				}))
				services.orpc = createMockORPCClient({
					reviewProgression: {
						admission: async () => ({
							kind: 'enrolled',
							snapshot: { ...value, executionDigest: hash(reviewExecutionPayload(session)) },
						}),
					},
					sessions: { update },
				})
				services.syncService = {
					ensureTaskSync: async () => ({ flushArtifactWrites: async () => {} }),
				} as unknown as DaemonServices['syncService']
				const execute = vi.fn(async () => {})
				services.executors.codelayer = observeReviewExecutor(execute, observations)
				services.executors.claude = observeReviewExecutor(execute, observations, true)
				if (kind === 'live') {
					session.status = 'resuming'
					const deliver = vi.fn(() => Effect.succeed('accepted' as const))
					const runPromise = services.daemonRuntime.runPromise.bind(services.daemonRuntime)
					const spy = vi
						.spyOn(services.daemonRuntime, 'runPromise')
						.mockImplementation((effect, options) =>
							runPromise(
								effect.pipe(
									Effect.provideService(ClaudeSessions, { deliverFollowUpMessage: deliver } as never),
								),
								options,
							),
						)
					try {
						await handleContinueSession({ type: 'update', key: id, value: session } as never, services)
						expect(deliver).toHaveBeenCalledOnce()
						expect(execute).not.toHaveBeenCalled()
						expect(observations.runs.get(id)).toBe(original)
						deliver.mockImplementation(() => Effect.succeed('closed' as never))
						await handleContinueSession({ type: 'update', key: id, value: session } as never, services)
						expect(deliver).toHaveBeenCalledTimes(2)
						expect(execute).not.toHaveBeenCalled()
						expect(observations.runs.get(id)).toBe(original)
						expect(update.mock.calls.every(([input]) => input.status === undefined)).toBe(true)
					} finally {
						spy.mockRestore()
					}
					return
				}
				if (kind !== 'reconstruction') {
					expect(await handleLaunchSession({ type: 'update', value: session }, services)).toBe(
						'review_setup_unverified',
					)
					const handoff = await services.daemonRuntime.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const runner = yield* WorkspaceSessionRunner
								return yield* runner.handOffReadySession({ sessionId: id })
							}).pipe(
								Effect.provide(
									WorkspaceSessionRunnerLive.pipe(
										Layer.provideMerge(makeLegacySessionLaunchExecutorLive(services)),
									),
								),
							),
						),
					)
					expect(handoff).toMatchObject({ _tag: 'Deferred', reason: 'review_setup_unverified' })
				}
				session.status = 'resuming'
				await handleContinueSession({ type: 'update', key: id, value: session } as never, services)
				expect(execute).not.toHaveBeenCalled()
				expect(update.mock.calls.every(([input]) => input.status === undefined)).toBe(true)
				if (observations.runs.has(priorId)) expect(observations.runs.get(priorId)).toBe(original)
			} finally {
				await services.daemonRuntime.dispose()
				await rm(root, { recursive: true, force: true })
			}
		},
	)
	it('rechecks same-task evidence atomically at executor handoff after successful admission', async () => {
		const candidate = createTestSession({ ...execution() })
		const value = {
			...snapshot(),
			verifiedBinding: binding,
			bindingDigest: hash(binding),
			scopeSha256: hash(reviewHelperScope(scopeInputs(), binding)),
		}
		const api = createMockORPCClient({
			reviewProgression: { admission: async () => ({ kind: 'enrolled', snapshot: value }) },
		})
		const observations: ReviewWriterObservations = { runs: new Map() }
		expect(
			await admitReviewSession(
				id,
				api,
				async () => local(),
				async () => binding,
				async () => {},
				async () => {},
				candidate,
				observations,
			),
		).toBe(true)
		const prior = { taskId: id, identity: 'prior', running: false, uncertain: true }
		observations.runs.set('sibling', prior)
		const execute = vi.fn(async () => {})
		await expect(observeReviewExecutor(execute, observations)({ session: candidate } as never)).rejects.toThrow(
			'Earlier work',
		)
		expect(execute).not.toHaveBeenCalled()
		expect(observations.runs.get('sibling')).toBe(prior)
		expect(observations.runs.has(id)).toBe(false)
	})
	it.each([
		{ specBacked: false, cancel: false },
		{ specBacked: true, cancel: false },
		{ specBacked: false, cancel: true },
		{ specBacked: true, cancel: true },
	])(
		'one lifecycle hint recovers enrolled legacy spec=$specBacked, teardown=$cancel without a task mutation',
		async ({ specBacked, cancel }) => {
			const root = await realpath(await mkdtemp(join(tmpdir(), 'review-launch-recovery-')))
			const services = createMockDaemonServices()
			const exec = promisify(execFile)
			try {
				await exec('git', ['-C', root, 'init', '-b', 'codex/test'])
				await exec('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/product.git'])
				const helperBytes = JSON.stringify(staticConfig()),
					bridgeBytes = JSON.stringify(bridgeConfig())
				const helper = { path: join(root, 'helper'), digest: bytesHash(helperBytes) },
					bridge = { path: join(root, 'bridge'), digest: bytesHash(bridgeBytes) }
				await writeFile(helper.path, helperBytes, { mode: 0o600 })
				await writeFile(bridge.path, bridgeBytes, { mode: 0o600 })
				const enrollment = {
					...local(),
					roots: [root],
					helper,
					helperConfig: helper,
					bridge: { submitter: helper, configuration: bridge, returnRouteRefs: ['origin'] },
					inPlace: [{ directory: root, repository: binding.repository, branch: binding.branch }],
				}
				const value = snapshot()
				const sourceId = `01900000-0000-7000-8000-00000000001${Number(specBacked) + 2 * Number(cancel)}`
				const session = createTestSession({ ...execution(), id: sourceId, working_directory: root })
				value.sourceSessionId = sourceId
				value.workingDirectory = root
				value.executionDigest = hash(reviewExecutionPayload(session))
				if (specBacked) {
					value.workspaceSpec = {
						specVersion: 1,
						directory: root,
						workspaceBaseDirectory: root,
						setupBlocksFirstSession: true,
						repos: [
							{
								localPath: '.',
								targetPath: root,
								branch: binding.branch,
								sourceRef: 'HEAD',
								copyGlobs: [],
								primary: true,
							},
						],
					}
					value.placement = {
						kind: 'legacy_directory',
						projectId: null,
						workspaceId: null,
						setupRowId: id,
						workspaceSpecDigest: hash(value.workspaceSpec),
					}
					value.scopeInputs.placement = value.placement
					value.scopeInputs.workspaceSpec = value.workspaceSpec
				}
				const actualBinding = {
					...binding,
					workingDirectory: root,
					repositoryDirectory: root,
					helperConfigDigest: helper.digest,
				}
				value.verifiedBinding = actualBinding
				value.bindingDigest = hash(actualBinding)
				value.scopeSha256 = hash(reviewHelperScope(value.scopeInputs, actualBinding))
				isolatedPaths.config = join(root, 'runtime-config')
				isolatedPaths.artifacts = join(root, 'artifacts')
				await mkdir(isolatedPaths.artifacts)
				await writeFile(join(isolatedPaths.artifacts, 'task.md'), value.scopeInputs.accepted, { mode: 0o600 })
				await writeFile(
					join(isolatedPaths.artifacts, reviewDeliveryContextFile(sourceId)),
					canonicalReviewValue(reviewDeliveryContext(value)),
					{ mode: 0o600 },
				)
				const admission = vi
					.fn<ORPCClient['reviewProgression']['admission']>()
					.mockResolvedValue({ kind: 'enrolled', snapshot: value })
				const update = vi.fn<ORPCClient['sessions']['update']>().mockResolvedValue({} as never)
				services.orpc = createMockORPCClient({ reviewProgression: { admission }, sessions: { update } })
				const task = {
					id,
					workspace_id: null,
					workspace_spec: value.workspaceSpec,
					is_draft: false,
					archived: false,
				}
				services.collections.tasks = { toArray: [task] } as unknown as DaemonServices['collections']['tasks']
				services.collections.sessions = {
					toArray: [session],
				} as unknown as DaemonServices['collections']['sessions']
				services.collections.workspaceSetup = {
					toArray: [
						{
							id,
							task_id: id,
							host_id: session.host_id,
							workspace_setup_state: {
								specVersion: 1,
								repos: specBacked ? [{ localPath: '.', status: 'done' }] : [],
							},
						},
					],
				} as unknown as DaemonServices['collections']['workspaceSetup']
				const flushArtifactWrites = vi.fn(async () => {})
				services.syncService = {
					ensureTaskSync: async () => ({ flushArtifactWrites }),
				} as unknown as DaemonServices['syncService']
				const execute = vi.fn(async () => {})
				services.executors.codelayer = execute
				const lifecycle: TaskDiffCollectionLifecycle = {
					reconcileSessionChanges: () => undefined,
					reconcileTaskChanges: () => undefined,
					reconcileAllTasks: () => undefined,
				}
				const change = { type: 'update', key: id, value: task } as unknown as Parameters<
					typeof processTaskChange
				>[0]
				// Publish exactly one lifecycle hint. Only local files/API availability change after this.
				const sessionRuns = WorkspaceSessionRunnerLive.pipe(
					Layer.provideMerge(makeLegacySessionLaunchExecutorLive(services)),
				)
				const run = services.daemonRuntime.runFork(
					Effect.scoped(
						processTaskChange(change, services, lifecycle).pipe(
							Effect.andThen(Effect.never),
							Effect.provide(sessionRuns),
						),
					),
				)
				await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(1))
				await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
				expect(execute).not.toHaveBeenCalled()
				if (cancel) await services.daemonRuntime.runPromise(Fiber.interrupt(run))
				await writeFile(
					isolatedPaths.config,
					JSON.stringify({ reviewProgressionEnrollments: { personal: enrollment } }),
					{ mode: 0o600 },
				)
				if (cancel) {
					await new Promise((resolve) => setTimeout(resolve, 2200))
					expect(admission).toHaveBeenCalledTimes(1)
					expect(execute).not.toHaveBeenCalled()
					return
				}
				admission.mockRejectedValueOnce(new Error('api_unavailable'))
				await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(2), { timeout: 5000 })
				expect(execute).not.toHaveBeenCalled()
				expect(update.mock.calls.every(([input]) => input.status === undefined)).toBe(true)
				await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 5000 })
				expect(execute).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						session: expect.objectContaining({
							id: sourceId,
							prompt: session.prompt,
							working_directory: root,
							model: session.model,
							permissions_mode: session.permissions_mode,
						}),
					}),
					undefined,
					undefined,
				)
				expect(update).toHaveBeenCalledWith({ sessionId: sourceId, errorMessage: '' })
				expect(flushArtifactWrites).toHaveBeenCalledOnce()
				const callsAfterLaunch = admission.mock.calls.length
				await new Promise((resolve) => setTimeout(resolve, 2200))
				expect(admission).toHaveBeenCalledTimes(callsAfterLaunch)
				expect(execute).toHaveBeenCalledOnce()
				await services.daemonRuntime.runPromise(Fiber.interrupt(run))
			} finally {
				await services.daemonRuntime.dispose()
				await rm(root, { recursive: true, force: true })
			}
		},
		15000,
	)
	it('rejects executable or destination fields in the closed enrollment and route refs', () => {
		expect(ReviewLocalEnrollmentSchema.safeParse({ ...local(), argv: ['sh'] }).success).toBe(false)
		expect(
			ReviewLocalEnrollmentSchema.safeParse({
				...local(),
				bridge: { ...local().bridge, returnRouteRefs: ['/private/route'] },
			}).success,
		).toBe(false)
	})
	it('keeps static helper options closed and rejects per-task identity, self-digest and callback injection', () => {
		expect(ReviewStaticHelperConfigSchema.safeParse({}).success).toBe(false)
		expect(ReviewBridgeBindingSchema.safeParse({}).success).toBe(false)
		expect(ReviewBridgeBindingSchema.safeParse(bridgeConfig()).success).toBe(true)
		expect(ReviewStaticHelperConfigSchema.safeParse(staticConfig()).success).toBe(true)
		for (const field of [
			'task_id',
			'pr',
			'delivery',
			'verified_binding',
			'helperConfigDigest',
			'notification_argv',
		])
			expect(ReviewStaticHelperConfigSchema.safeParse({ ...staticConfig(), [field]: 'untrusted' }).success).toBe(
				false,
			)
		expect(
			ReviewStaticHelperConfigSchema.safeParse({
				...staticConfig(),
				options: { ...staticConfig().options, humanlayer_cli: ['humanlayer', '--token=secret'] },
			}).success,
		).toBe(false)
	})
	it('requires pinned private files, canonical paths, authorized in-place checkout and the actual Git destination', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'review-placement-')))
		const exec = promisify(execFile)
		const git = (...args: string[]) => exec('git', ['--no-optional-locks', '-C', root, ...args])
		try {
			await git('init', '-b', 'codex/test')
			await git('remote', 'add', 'origin', 'https://github.com/example/product.git')
			const file = join(root, 'helper-config')
			const configBytes = JSON.stringify(staticConfig())
			await writeFile(file, configBytes, { mode: 0o600 })
			const pinned = { path: file, digest: bytesHash(configBytes) }
			const bridgeFile = join(root, 'bridge-config'),
				bridgeBytes = JSON.stringify(bridgeConfig())
			await writeFile(bridgeFile, bridgeBytes, { mode: 0o600 })
			const bridgePin = { path: bridgeFile, digest: bytesHash(bridgeBytes) }
			const enrollment = {
				...local(),
				roots: [root],
				helper: pinned,
				helperConfig: pinned,
				bridge: { submitter: pinned, configuration: bridgePin, returnRouteRefs: ['origin'] },
				inPlace: [{ directory: root, repository: 'example/product', branch: 'codex/test' }],
			}
			const value = { ...snapshot(), workingDirectory: root }
			expect(await verifyReviewPlacement(value, enrollment)).toEqual({
				...binding,
				workingDirectory: root,
				repositoryDirectory: root,
				helperConfigDigest: pinned.digest,
			})
			for (const invalid of [
				{},
				{ ...bridgeConfig(), hostId: 'other' },
				{ ...bridgeConfig(), ownerUserId: 'other' },
				{ ...bridgeConfig(), returnRouteRefs: ['other'] },
			]) {
				const content = JSON.stringify(invalid)
				await writeFile(bridgeFile, content)
				await expect(
					verifyReviewPlacement(value, {
						...enrollment,
						bridge: {
							...enrollment.bridge,
							configuration: { path: bridgeFile, digest: bytesHash(content) },
						},
					}),
				).rejects.toThrow()
			}
			await writeFile(bridgeFile, bridgeBytes)
			await writeFile(file, '{}')
			await expect(
				verifyReviewPlacement(value, {
					...enrollment,
					helperConfig: { path: file, digest: bytesHash('{}') },
					helper: { path: file, digest: bytesHash('{}') },
					bridge: { ...enrollment.bridge, submitter: { path: file, digest: bytesHash('{}') } },
				}),
			).rejects.toThrow()
			await writeFile(file, configBytes)
			await expect(verifyReviewPlacement(value, { ...enrollment, inPlace: [] })).rejects.toThrow(
				'in_place_checkout_not_authorized',
			)
			await expect(verifyReviewPlacement(value, { ...enrollment, roots: [join(root, '.git')] })).rejects.toThrow(
				'checkout_outside_enrolled_roots',
			)
			await git('remote', 'set-url', '--push', 'origin', 'https://github.com/other/product.git')
			await expect(verifyReviewPlacement(value, enrollment)).rejects.toThrow('repository_not_enrolled')
			await git('remote', 'set-url', '--push', 'origin', 'https://github.com/example/product.git')
			await writeFile(file, '{"changed":true}')
			await expect(verifyReviewPlacement(value, enrollment)).rejects.toThrow('pinned_file_changed')
			await writeFile(file, configBytes)
			await chmod(file, 0o644)
			await expect(verifyReviewPlacement(value, enrollment)).rejects.toThrow('untrusted_file_permissions')
			await chmod(file, 0o600)
			const alias = join(root, 'alias')
			await symlink(file, alias)
			await expect(
				verifyReviewPlacement(value, { ...enrollment, helper: { ...pinned, path: alias } }),
			).rejects.toThrow('untrusted_file_path')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
	it('verifies raw imported and attachment bytes plus the source-visible confirmed context', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'review-artifacts-')))
		try {
			const value = snapshot()
			value.verifiedBinding = binding
			value.scopeInputs.artifacts.push({
				fileName: 'ticket.png',
				storageType: 's3',
				contentHash: 'legacy-provider-hash',
				contentType: 'image/png',
				fileSizeBytes: 3,
				bytesSha256: bytesHash('png'),
			})
			value.scopeSha256 = hash(reviewHelperScope(value.scopeInputs, binding))
			await writeFile(join(root, 'task.md'), 'Accepted task', { mode: 0o600 })
			await writeFile(join(root, 'ticket.png'), 'png', { mode: 0o600 })
			await writeFile(
				join(root, reviewDeliveryContextFile(id)),
				canonicalReviewValue(reviewDeliveryContext(value)),
				{ mode: 0o600 },
			)
			await verifyReviewArtifacts(value, root)
			await writeFile(join(root, 'ticket.png'), 'bad')
			await expect(verifyReviewArtifacts(value, root)).rejects.toThrow('accepted_artifact_bytes_changed')
			await writeFile(join(root, 'ticket.png'), 'png')
			await writeFile(
				join(root, reviewDeliveryContextFile(id)),
				canonicalReviewValue({ ...reviewDeliveryContext(value), scopeSha256: value.acceptedLaunchDigest }),
			)
			await expect(verifyReviewArtifacts(value, root)).rejects.toThrow('delivery_context_changed')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
	it('requires the existing sync context to flush accepted files and the confirmed scope artifact', async () => {
		const value = snapshot()
		const flushArtifactWrites = vi.fn(async (_files: readonly { fileName: string; contentHash: string }[]) => {})
		const services = {
			syncService: { ensureTaskSync: vi.fn(async () => ({ flushArtifactWrites })) },
		} as unknown as Pick<DaemonServices, 'syncService'>
		await prepareReviewSessionArtifacts(services, value)
		expect(flushArtifactWrites.mock.calls[0]?.[0]).toContainEqual(
			expect.objectContaining({ fileName: reviewDeliveryContextFile(id) }),
		)
		await expect(
			prepareReviewSessionArtifacts(
				{ syncService: { ensureTaskSync: async () => ({}) } } as unknown as Pick<DaemonServices, 'syncService'>,
				value,
			),
		).rejects.toThrow('artifact_sync_unavailable')
	})
})

import { createHash } from 'node:crypto'

import { describe, it } from '@effect/vitest'
import type { Session } from '@humanlayer/db/tables/sessions'
import type { Task } from '@humanlayer/db/tables/tasks'
import type { ReviewProgressionSnapshot } from '@humanlayer/riptide-api-contract/daemon/review-progression'
import {
	canonicalReviewValue,
	reviewExecutionPayload,
	reviewHelperScope,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { Deferred, Effect, Layer, Queue } from 'effect'

import type { DaemonServices } from '@/agents/claudecode/types'
import { DaemonCollectionsLive } from '@/effects/services/daemon-collections/daemon-collections.layer'
import { admitReviewSession } from '@/effects/services/review-integration/review-integration'
import { SessionLaunchExecutor } from '@/effects/services/session-runs/session-launch-executor.service'
import { SessionRunRegistry, SessionRunRegistryLive } from '@/effects/services/session-runs/session-run-registry'
import { WorkspaceSessionRunnerLive } from '@/effects/services/workspace-session-launch/workspace-session-runner.layer'
import { WorkspaceSessionRunner } from '@/effects/services/workspace-session-launch/workspace-session-runner.service'

import { createMockDaemonServices } from '../helpers/create-mock-daemon-services'
import { createTestSession } from '../helpers/session-fixtures'
import { createMockORPCClient } from '../mocks/orpc-client.mock'

const taskId = '00000000-0000-4000-8000-000000000223'
const task = { id: taskId, workspace_id: '00000000-0000-4000-8000-000000000224' } as Task

/**
 * Real registry and real collections; the executor is a recording fake whose run never ends on
 * its own, so the test controls exactly when a run finishes or is interrupted.
 */
const makeHarness = Effect.gen(function* () {
	const sessions = createCollection(localOnlyCollectionOptions<Session>({ getKey: (row) => row.id }))
	const tasks = createCollection(localOnlyCollectionOptions<Task>({ getKey: (row) => row.id }))
	yield* Effect.addFinalizer(() =>
		Effect.promise(async () => {
			await sessions.cleanup()
			await tasks.cleanup()
		}),
	)
	const defaults = createMockDaemonServices()
	yield* Effect.addFinalizer(() => Effect.promise(() => defaults.daemonRuntime.dispose()))
	const collections = { ...defaults.collections, sessions, tasks } as unknown as DaemonServices['collections']

	const started = yield* Queue.unbounded<string>()
	const interrupted = yield* Queue.unbounded<string>()
	const finishRun = yield* Deferred.make<void>()
	let admitted = true
	let admissionCheck: ((session: Session) => Promise<boolean>) | undefined
	const ExecutorFake = Layer.succeed(SessionLaunchExecutor, {
		admitSessionLaunch: ({ session }) =>
			admissionCheck ? Effect.promise(() => admissionCheck!(session)) : Effect.sync(() => admitted),
		executeSessionLaunch: ({ session }) =>
			Queue.offer(started, session.id).pipe(
				Effect.andThen(Deferred.await(finishRun)),
				Effect.onInterrupt(() => Queue.offer(interrupted, session.id)),
			),
	})
	const dependencies = Layer.mergeAll(SessionRunRegistryLive, ExecutorFake, DaemonCollectionsLive(collections))
	const runner = WorkspaceSessionRunnerLive
	const session = createTestSession({ task_id: taskId, status: 'waiting_for_workspace' })
	return {
		sessions,
		tasks,
		session,
		started,
		interrupted,
		finishRun,
		dependencies,
		runner,
		setAdmission: (value: boolean) => {
			admitted = value
		},
		setAdmissionCheck: (check: (session: Session) => Promise<boolean>) => {
			admissionCheck = check
		},
	}
})

describe('WorkspaceSessionRunnerLive', () => {
	it.effect(
		'defers stale synced execution payloads despite current authoritative admission, then hands off the exact restored source',
		({ expect }) =>
			Effect.gen(function* () {
				const h = yield* makeHarness
				const hash = (value: unknown) => createHash('sha256').update(canonicalReviewValue(value)).digest('hex')
				const binding = {
					workingDirectory: h.session.working_directory,
					repositoryDirectory: h.session.working_directory,
					repository: 'example/product',
					branch: 'codex/test',
					helperConfigDigest: 'a'.repeat(64),
				}
				const placement = {
					kind: 'project_workspace' as const,
					projectId: taskId,
					workspaceId: task.workspace_id!,
					setupRowId: null,
				}
				const scopeInputs = {
					task: {
						id: taskId,
						name: 'Accepted',
						slug: 'accepted',
						project_id: taskId,
						workspace_id: task.workspace_id!,
						resource_owner_user_id: h.session.resource_owner_user_id,
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
							contentHash: 'fixture',
							contentType: 'text/markdown',
							fileSizeBytes: 13,
							bytesSha256: 'b'.repeat(64),
						},
					],
					placement,
					repositories: null,
					workspaceSpec: null,
				}
				const snapshot: ReviewProgressionSnapshot = {
					taskId,
					sourceSessionId: h.session.id,
					organizationId: taskId,
					ownerUserId: h.session.resource_owner_user_id,
					hostId: h.session.host_id,
					enrollment: { enrollmentId: 'personal', returnRouteRef: 'origin' },
					placement,
					acceptedLaunchDigest: 'c'.repeat(64),
					executionDigest: hash(reviewExecutionPayload(h.session)),
					workingDirectory: h.session.working_directory,
					repositories: null,
					workspaceSpec: null,
					setupComplete: true,
					verifiedBinding: binding,
					bindingDigest: hash(binding),
					scopeInputs,
					sourceCreatedAtMs: Number(h.session.created_at),
					scopeSha256: hash(reviewHelperScope(scopeInputs, binding)),
				}
				const api = createMockORPCClient({
					reviewProgression: { admission: async () => ({ kind: 'enrolled', snapshot }) },
				})
				h.setAdmissionCheck((session) =>
					admitReviewSession(
						session.id,
						api,
						async () => ({}) as never,
						async () => binding,
						async () => {},
						async () => {},
						session,
						{ runs: new Map() },
					),
				)
				h.sessions.insert(h.session)
				h.tasks.insert(task)
				yield* Effect.gen(function* () {
					const runner = yield* WorkspaceSessionRunner
					for (const changes of [
						{ prompt: 'stale prompt' },
						{ working_directory: '/fictional/stale' },
						{ permissions_mode: 'default' },
						{ model: 'stale model' },
						{ effort: 'stale' },
						{ fast_mode: !h.session.fast_mode },
					] satisfies Partial<Session>[]) {
						h.sessions.update(h.session.id, (row) => {
							Object.assign(row, h.session, changes)
						})
						expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
							_tag: 'Deferred',
							reason: 'review_setup_unverified',
						})
						expect(yield* Queue.size(h.started)).toBe(0)
					}
					h.sessions.update(h.session.id, (row) => {
						Object.assign(row, h.session)
					})
					expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
						_tag: 'HandedOff',
					})
					expect(yield* Queue.take(h.started)).toBe(h.session.id)
				}).pipe(Effect.provide(h.runner), Effect.provide(h.dependencies))
			}).pipe(Effect.scoped),
	)
	it.effect(
		'retains an unverified launch and hands off once after validated admission becomes available',
		({ expect }) =>
			Effect.gen(function* () {
				const h = yield* makeHarness
				h.sessions.insert(h.session)
				h.tasks.insert(task)
				h.setAdmission(false)
				yield* Effect.gen(function* () {
					const runner = yield* WorkspaceSessionRunner
					expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
						_tag: 'Deferred',
						reason: 'review_setup_unverified',
					})
					expect(yield* Queue.size(h.started)).toBe(0)
					h.setAdmission(true)
					expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
						_tag: 'HandedOff',
					})
					expect(yield* Queue.take(h.started)).toBe(h.session.id)
					expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
						_tag: 'Skipped',
						reason: 'session_run_in_flight',
					})
					expect(yield* Queue.size(h.started)).toBe(0)
				}).pipe(Effect.provide(h.runner), Effect.provide(h.dependencies))
			}).pipe(Effect.scoped),
	)

	it.effect('defers until rows sync, hands off exactly once, and skips while the run is in flight', ({ expect }) =>
		Effect.gen(function* () {
			const h = yield* makeHarness
			yield* Effect.gen(function* () {
				const runner = yield* WorkspaceSessionRunner
				const registry = yield* SessionRunRegistry
				const handOff = runner.handOffReadySession({ sessionId: h.session.id })
				const inFlight = registry.isSessionRunInFlight({ sessionId: h.session.id })

				expect(yield* handOff).toEqual({ _tag: 'Deferred', reason: 'session_not_synced' })
				h.sessions.insert(h.session)
				expect(yield* handOff).toEqual({ _tag: 'Deferred', reason: 'task_not_synced' })
				h.tasks.insert(task)

				expect(yield* handOff).toEqual({ _tag: 'HandedOff' })
				expect(yield* Queue.take(h.started)).toBe(h.session.id)
				expect(yield* inFlight).toBe(true)
				// A second handoff for the same session never starts a second run.
				expect(yield* handOff).toEqual({ _tag: 'Skipped', reason: 'session_run_in_flight' })
				expect(yield* Queue.size(h.started)).toBe(0)

				h.sessions.update(h.session.id, (row) => {
					row.status = 'running'
				})
				expect(yield* handOff).toEqual({ _tag: 'Skipped', reason: 'local_status_running' })
			}).pipe(Effect.provide(h.runner), Effect.provide(h.dependencies))
		}).pipe(Effect.scoped),
	)

	it.effect('interrupts handed-off runs and releases the registry when the runner layer shuts down', ({ expect }) =>
		Effect.gen(function* () {
			const h = yield* makeHarness
			h.tasks.insert(task)
			h.sessions.insert(h.session)
			// The registry outlives the runner layer, as it does in the daemon, so its view of the
			// session after shutdown is observable.
			yield* Effect.gen(function* () {
				const registry = yield* SessionRunRegistry
				yield* Effect.gen(function* () {
					const runner = yield* WorkspaceSessionRunner
					expect(yield* runner.handOffReadySession({ sessionId: h.session.id })).toEqual({
						_tag: 'HandedOff',
					})
					expect(yield* Queue.take(h.started)).toBe(h.session.id)
					expect(yield* registry.isSessionRunInFlight({ sessionId: h.session.id })).toBe(true)
				}).pipe(Effect.provide(h.runner))
				// Leaving the provided block closed the runner layer's scope.
				expect(yield* Queue.take(h.interrupted)).toBe(h.session.id)
				expect(yield* registry.isSessionRunInFlight({ sessionId: h.session.id })).toBe(false)
			}).pipe(Effect.provide(h.dependencies))
		}).pipe(Effect.scoped),
	)
})

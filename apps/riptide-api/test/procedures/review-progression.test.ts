import { createHash } from 'node:crypto'

import { approvals } from '@humanlayer/db/tables/approvals'
import { artifactOperationsLog } from '@humanlayer/db/tables/artifact-operations-log'
import { artifactVersions } from '@humanlayer/db/tables/artifact-versions'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizationSettings } from '@humanlayer/db/tables/organization-settings'
import { organizations } from '@humanlayer/db/tables/organizations'
import { pullRequestSessions } from '@humanlayer/db/tables/pull-request-sessions'
import { pullRequests } from '@humanlayer/db/tables/pull-requests'
import { queuedMessages } from '@humanlayer/db/tables/queued-messages'
import { reviewProgression } from '@humanlayer/db/tables/review-progression'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { taskUserAcl } from '@humanlayer/db/tables/task-user-acl'
import { taskWorkspaceSetupForHost } from '@humanlayer/db/tables/task-workspace-setup-for-host'
import { tasks } from '@humanlayer/db/tables/tasks'
import { userSettings } from '@humanlayer/db/tables/user-settings'
import { workspaceLocationsForUserForHost as locations } from '@humanlayer/db/tables/workspace-locations-for-user-for-host'
import { workspaceRepositoryStatusForUserForHost as statuses } from '@humanlayer/db/tables/workspace-repository-status-for-user-for-host'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import type { UpdateTaskInputSchema } from '@humanlayer/riptide-api-contract/api/tasks/update'
import { CreateTaskV2InputSchema } from '@humanlayer/riptide-api-contract/api/tasks/v2/create'
import {
	canonicalReviewValue,
	reviewExecutionPayload,
	reviewHelperScope,
	reviewDeliveryContextFile,
	workflowMutationPayload,
	type WorkflowPatch,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { createFilesystemWorkspaceActorFixture } from '@humanlayer/test-fixtures/project-workspaces'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect } from 'effect'
import { hash } from 'ohash'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type z from 'zod/v4'

import {
	acceptedReviewLaunch,
	retainReviewEnrollment,
	reviewDigest,
	prepareReviewArtifacts,
	lockReviewTask,
	wakeReviewTask,
	beginReviewWriter,
	finishReviewWriter,
	beginReviewWorkflow,
	finishReviewWorkflow,
	reviewWorkEntry,
} from '../../src/db/review-progression'
import { recordPullRequest } from '../../src/effects/services/github/pull-requests/persistence'
import { PostgresDbLive } from '../../src/effects/services/postgres/postgres-db.service'
import { getSessionAccessControlLevelForClassicProcedure } from '../../src/lib/session-multiplayer-prompting-auth'
import { continueSessionProcedure } from '../../src/orpc/api/sessions/continue'
import { launchSessionProcedure } from '../../src/orpc/api/sessions/launch'
import { updateSessionApiProcedure } from '../../src/orpc/api/sessions/update'
import { continueSessionV2Procedure } from '../../src/orpc/api/sessions/v2/continue'
import { createSessionV2Procedure } from '../../src/orpc/api/sessions/v2/create.effect'
import { updateTaskProcedure } from '../../src/orpc/api/tasks/update'
import { upsertArtifactProcedure } from '../../src/orpc/daemon/artifacts/upsert'
import { reviewProgressionProcedures } from '../../src/orpc/daemon/review-progression'
import { checkAutoAdvance } from '../../src/orpc/daemon/sessions/check-auto-advance'
import { updateSessionProcedure } from '../../src/orpc/daemon/sessions/update'
import { syncDaemonReviewProgressionProcedure } from '../../src/orpc/daemon/sync/review-progression'
import { createMockApiContext, createMockDaemonContext } from '../mocks'
import { createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('review progression authoritative admission and confirmation', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	beforeAll(async () => {
		const fixture = await createTestDb('review-progression')
		db = fixture.db
		cleanup = fixture.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db)
	}, 60_000)
	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	}, 30_000)

	async function setup(specBacked = false) {
		const organizationId = uuidv7(),
			taskId = uuidv7(),
			sessionId = uuidv7(),
			setupRowId = uuidv7()
		const userId = 'fictional-owner',
			hostId = uuidv7(),
			directory = '/fictional/product'
		const text =
			'Publish in this same session with a separate DeliveryReportV1; independent review is separate. No merge authority.'
		const spec = specBacked
			? {
					specVersion: 1,
					directory: '/fictional/source',
					workspaceBaseDirectory: '/fictional',
					setupBlocksFirstSession: true,
					repos: [
						{
							localPath: 'product',
							targetPath: directory,
							branch: 'codex/delivery',
							sourceRef: 'main',
							copyGlobs: [],
							primary: true,
						},
					],
				}
			: null
		await db.insert(organizations).values({
			id: organizationId,
			name: 'Fictional enrollment',
			workos_organization_id: `org-${organizationId}`,
		})
		await db.insert(tasks).values({
			id: taskId,
			organization_id: organizationId,
			created_by: userId,
			resource_owner_user_id: userId,
			name: 'Delivery',
			slug: 'delivery',
			default_working_directory: directory,
			workflow_type: 'freeform',
			workspace_spec: spec,
		})
		await db.insert(sessions).values({
			id: sessionId,
			task_id: taskId,
			organization_id: organizationId,
			created_by: userId,
			resource_owner_user_id: userId,
			host_id: hostId,
			working_directory: directory,
			status: 'ready_for_launch',
			prompt: text,
			coding_agent: 'codelayer',
			provider: 'codex',
			model: 'fictional-model',
			permissions_mode: 'default',
		})
		await db.insert(artifacts).values({
			task_id: taskId,
			task_slug: 'delivery',
			organization_id: organizationId,
			created_by: userId,
			resource_owner_user_id: userId,
			file_name: 'task.md',
			content: text,
			content_hash: hash(text),
			content_type: 'text/markdown',
			file_size_bytes: BigInt(Buffer.byteLength(text)),
			storage_type: 'postgres',
		})
		await db.insert(taskWorkspaceSetupForHost).values({
			id: setupRowId,
			task_id: taskId,
			organization_id: organizationId,
			host_id: hostId,
			status: 'done',
			resolved_workspace_spec: spec,
			workspace_setup_state: {
				specVersion: 1,
				repos: specBacked ? [{ localPath: 'product', status: 'done' }] : [],
			},
		})
		const acceptedLaunch = acceptedReviewLaunch({
			taskContent: text,
			defaultWorkingDirectory: directory,
			firstSession: {
				text,
				workingDirectory: directory,
				codingAgent: 'codelayer',
				provider: 'codex',
				model: 'fictional-model',
				permissionsMode: 'default',
			},
		})
		const enrollment = { enrollmentId: 'personal', returnRouteRef: 'origin_1' }
		await db.transaction((tx) =>
			retainReviewEnrollment(tx, {
				taskId,
				organizationId,
				ownerUserId: userId,
				hostId,
				sourceSessionId: sessionId,
				enrollment,
				acceptedLaunch,
				placement: {
					kind: 'legacy_directory',
					projectId: null,
					workspaceId: null,
					setupRowId,
					workspaceSpecDigest: spec ? reviewDigest(spec) : null,
				},
			}),
		)
		const context = createMockDaemonContext({
			auth: { organizationId, userId, hostId },
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		})
		const binding = {
			workingDirectory: directory,
			repositoryDirectory: directory,
			repository: 'example/product',
			branch: 'codex/delivery',
			helperConfigDigest: 'a'.repeat(64),
		}
		const confirmation = {
			taskId,
			sourceSessionId: sessionId,
			acceptedLaunchDigest: reviewDigest(acceptedLaunch),
			bindingDigest: reviewDigest(binding),
			binding,
		}
		const read = () => call(reviewProgressionProcedures.admission, { sessionId }, { context })
		const confirm = () => call(reviewProgressionProcedures.confirmPlacement, confirmation, { context })
		return { organizationId, taskId, sessionId, setupRowId, read, confirm, context, confirmation, binding }
	}

	async function setupV2() {
		const f = await createFilesystemWorkspaceActorFixture(db, {
			workspaceId: uuidv7(),
			hostId: uuidv7(),
			targetRoot: '/fictional/delivery',
			status: 'done',
			repositories: [
				{
					remoteUrl: 'https://github.com/example/product.git',
					repositoryIdentity: 'github.com/example/product',
					sourcePath: '/fictional/source',
					default: true,
				},
			],
		})
		const taskId = uuidv7(),
			sessionId = uuidv7(),
			directory = f.targetRoot
		const text = 'Implement and publish in this same session with DeliveryReportV1.'
		await db.insert(tasks).values({
			id: taskId,
			organization_id: f.organizationId,
			project_id: f.projectId,
			workspace_id: f.workspaceId,
			created_by: f.userId,
			resource_owner_user_id: f.userId,
			name: 'Delivery',
			slug: `delivery-${taskId}`,
			default_working_directory: directory,
			workflow_type: 'freeform',
		})
		await db.insert(sessions).values({
			id: sessionId,
			task_id: taskId,
			organization_id: f.organizationId,
			created_by: f.userId,
			resource_owner_user_id: f.userId,
			host_id: f.hostId,
			working_directory: directory,
			status: 'ready_for_launch',
			prompt: text,
			coding_agent: 'codelayer',
			provider: 'codex',
			model: 'fixture',
			permissions_mode: 'default',
		})
		await db.insert(artifacts).values({
			task_id: taskId,
			task_slug: `delivery-${taskId}`,
			organization_id: f.organizationId,
			created_by: f.userId,
			resource_owner_user_id: f.userId,
			file_name: 'task.md',
			content: text,
			content_hash: hash(text),
			content_type: 'text/markdown',
			file_size_bytes: BigInt(Buffer.byteLength(text)),
		})
		await db
			.update(statuses)
			.set({ materialization: { kind: 'worktree', path: directory, branch: f.repositories[0]!.branch } })
			.where(eq(statuses.workspace_id, f.workspaceId))
		const acceptedLaunch = acceptedReviewLaunch({
			taskContent: text,
			repositories: f.repositories,
			firstSession: {
				text,
				codingAgent: 'codelayer',
				provider: 'codex',
				model: 'fixture',
				permissionsMode: 'default',
			},
		})
		await db.transaction((tx) =>
			retainReviewEnrollment(tx, {
				taskId,
				organizationId: f.organizationId,
				ownerUserId: f.userId,
				hostId: f.hostId,
				sourceSessionId: sessionId,
				enrollment: { enrollmentId: 'personal', returnRouteRef: 'origin_1' },
				placement: {
					kind: 'project_workspace',
					projectId: f.projectId,
					workspaceId: f.workspaceId,
					setupRowId: null,
				},
				acceptedLaunch,
			}),
		)
		const context = createMockDaemonContext({
			auth: { organizationId: f.organizationId, userId: f.userId, hostId: f.hostId },
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		})
		const binding = {
			workingDirectory: directory,
			repositoryDirectory: directory,
			repository: 'example/product',
			branch: f.repositories[0]!.branch,
			helperConfigDigest: 'a'.repeat(64),
		}
		const confirmation = {
			taskId,
			sourceSessionId: sessionId,
			acceptedLaunchDigest: reviewDigest(acceptedLaunch),
			bindingDigest: reviewDigest(binding),
			binding,
		}
		return {
			...f,
			taskId,
			sessionId,
			context,
			binding,
			confirmation,
			read: () => call(reviewProgressionProcedures.admission, { sessionId }, { context }),
			confirm: () => call(reviewProgressionProcedures.confirmPlacement, confirmation, { context }),
		}
	}

	async function idleEnrollment() {
		const f = await setup()
		await f.confirm()
		await db
			.update(sessions)
			.set({ status: 'ready_for_input', execution_phase: 'review', execution_phase_at: 1n })
			.where(eq(sessions.id, f.sessionId))
		return f
	}
	async function reportFixture() {
		const f = await idleEnrollment()
		expect(await f.read()).toMatchObject({ kind: 'blocked' })
		const { snapshot } = await call(
			reviewProgressionProcedures.reports,
			{ taskId: f.taskId },
			{ context: f.context },
		)
		expect(snapshot.setupComplete).toBe(true)
		expect(snapshot.verifiedBinding).toEqual(f.binding)
		if (!snapshot.scopeSha256) throw new Error('Expected confirmed report scope')
		const fields = {
			version: 1 as const,
			kind: 'readiness' as const,
			enrollmentId: 'personal',
			outcomeKey: 'a'.repeat(64),
			repository: f.binding.repository,
			pr: 7,
			headSha: 'b'.repeat(40),
			scopeSha256: snapshot.scopeSha256,
			evidenceRef: 'fixture',
		}
		const request = {
			...fields,
			requestId: reviewDigest({
				enrollmentId: fields.enrollmentId,
				outcomeKey: fields.outcomeKey,
				repository: fields.repository,
				pr: fields.pr,
				headSha: fields.headSha,
				scopeSha256: fields.scopeSha256,
			}),
		}
		const content = `# Review report\n\n${canonicalReviewValue(request)}\n\nVerified fixture report.\n`
		const fileName = `review-report-${request.outcomeKey}.md`
		const upsert = (id: string, value = content) =>
			call(
				upsertArtifactProcedure,
				{
					id,
					taskId: f.taskId,
					fileName,
					content: value,
					ifExists: 'match',
					operationType: 'Write',
					operationContents: { content: value },
				},
				{ context: f.context },
			)
		const record = (receiptIdentity: string, value = content) =>
			call(
				reviewProgressionProcedures.recordDelivery,
				{
					kind: 'return_receipt',
					taskId: f.taskId,
					sourceSessionId: f.sessionId,
					request,
					deliveryStatus: 'delivered',
					destinationSlot: 'artifact',
					receiptIdentity,
					contentDigest: createHash('sha256').update(value).digest('hex'),
				},
				{ context: f.context },
			)
		const stored = async () => ({
			artifacts: await db.select().from(artifacts).where(eq(artifacts.task_id, f.taskId)),
			versions: await db.select().from(artifactVersions).where(eq(artifactVersions.task_id, f.taskId)),
			logs: await db.select().from(artifactOperationsLog).where(eq(artifactOperationsLog.task_id, f.taskId)),
		})
		return { ...f, request, content, fileName, upsert, record, stored }
	}
	test.each(['claim', 'continuation'] as const)(
		'actual PR observation and %s preserve atomic attribution and semantic wake',
		async (operation) => {
			const f = await idleEnrollment()
			await db.insert(sessionRepositories).values({
				organization_id: f.organizationId,
				session_id: f.sessionId,
				task_id: f.taskId,
				host_id: f.context.auth!.hostId,
				local_path: f.binding.workingDirectory,
				remote_url: 'https://github.com/example/product.git',
				repo_full_name: f.binding.repository,
				branch: f.binding.branch,
				is_head: true,
				last_seen_at: BigInt(Date.now()),
			})
			expect(await f.read()).toMatchObject({ kind: 'blocked' })
			const { snapshot } = await call(
				reviewProgressionProcedures.reports,
				{ taskId: f.taskId },
				{ context: f.context },
			)
			expect(snapshot.setupComplete).toBe(true)
			expect(snapshot.verifiedBinding).toEqual(f.binding)
			if (!snapshot.scopeSha256) throw new Error('Expected confirmed PR scope')
			await db
				.update(reviewProgression)
				.set({
					verified_pr_binding: {
						repository: f.binding.repository,
						branch: f.binding.branch,
						pr: 7,
						headSha: 'a'.repeat(40),
						sourceSessionId: f.sessionId,
						scopeSha256: snapshot.scopeSha256,
					},
				})
				.where(eq(reviewProgression.task_id, f.taskId))
			const before = await writerSnapshot(f)
			const observe = () =>
				Effect.runPromise(
					recordPullRequest({
						organizationId: f.organizationId,
						repoFullName: f.binding.repository,
						source: 'webhook',
						row: {
							id: 'fixture-pr',
							number: 7,
							title: 'Observed delivery',
							url: 'https://github.com/example/product/pull/7',
							state: 'open',
							isDraft: false,
							headRef: f.binding.branch,
							baseRef: 'main',
							headSha: 'b'.repeat(40),
							mergeable: true,
							reviewDecision: null,
							unresolvedThreadCount: null,
							resolvedThreadCount: null,
							changesRequestedReviews: null,
							merge: null,
						},
					}).pipe(Effect.provide(PostgresDbLive(db))),
				)
			const claimId = uuidv7()
			const input = {
				sessionId: f.sessionId,
				eventId: uuidv7(),
				messageId: uuidv7(),
				text: 'Resume implementation',
				intent: 'send' as const,
				permissionsMode: 'default' as const,
				executionPhase: 'implementation' as const,
			}
			const [observed, admitted] = await Promise.all([
				observe(),
				operation === 'claim'
					? call(
							reviewProgressionProcedures.claim,
							{
								taskId: f.taskId,
								claimId,
								expectedWakeRevision: before.review[0]!.wake_revision.toString(),
							},
							{ context: f.context },
						)
					: call(continueSessionProcedure, input, { context: apiContext(f) }),
			])
			expect(observed.hasOwner).toBe(true)
			const [pr] = await db.select().from(pullRequests).where(eq(pullRequests.organization_id, f.organizationId))
			expect(pr).toMatchObject({ task_id: f.taskId, session_id: f.sessionId, head_sha: 'b'.repeat(40) })
			expect(
				await db
					.select()
					.from(pullRequestSessions)
					.where(eq(pullRequestSessions.organization_id, f.organizationId)),
			).toEqual([expect.objectContaining({ task_id: f.taskId, session_id: f.sessionId, number: 7 })])
			const after = await writerSnapshot(f)
			expect(after.review[0]!.wake_revision).toBe(
				before.review[0]!.wake_revision + (operation === 'claim' ? 1n : 2n),
			)
			expect(after.sessions).toHaveLength(1)
			expect(after.queue).toEqual(before.queue)
			if (operation === 'claim') {
				expect(admitted).toMatchObject({ kind: expect.stringMatching(/^(claimed|stale)$/) })
				expect(after.events).toEqual(before.events)
			} else {
				expect(after.events).toEqual([expect.objectContaining({ id: input.eventId, content: input.text })])
				expect(after.review[0]!.writer_receipts).toHaveLength(1)
			}
			await observe()
			const replay = await writerSnapshot(f)
			expect(replay).toEqual(after)
		},
		15_000,
	)
	test('guarded report upsert reuses actual same-filename identity and real verifier rejects the unused proposal', async () => {
		const f = await reportFixture(),
			actual = uuidv7(),
			proposed = uuidv7()
		await f.upsert(actual)
		const before = await f.stored()
		expect(await f.upsert(proposed)).toMatchObject({ artifactId: actual, created: false })
		expect(await f.stored()).toEqual(before)
		await expect(f.record(proposed)).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(
			(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]!
				.report_receipts,
		).toEqual([])
		expect(await f.record(actual)).toMatchObject({ receiptIdentity: actual, requestId: f.request.requestId })
		expect(await f.stored()).toEqual(before)
	})
	test('guarded conflicting report preserves actual artifact, versions and operation log bytes', async () => {
		const f = await reportFixture(),
			actual = uuidv7()
		await f.upsert(actual, `${f.content}Earlier evidence.`)
		await call(
			upsertArtifactProcedure,
			{
				id: actual,
				taskId: f.taskId,
				fileName: f.fileName,
				content: f.content,
				operationType: 'Edit',
				operationContents: { content: f.content },
			},
			{ context: f.context },
		)
		const before = await f.stored()
		expect(before.versions).toHaveLength(1)
		expect(before.logs).toHaveLength(2)
		await expect(f.upsert(uuidv7(), `${f.content}Conflicting report.`)).rejects.toMatchObject({ code: 'CONFLICT' })
		expect(await f.stored()).toEqual(before)
		await expect(f.record(actual, `${f.content}Conflicting report.`)).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(
			(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]!
				.report_receipts,
		).toEqual([])
		expect(await f.record(actual)).toMatchObject({ receiptIdentity: actual })
	})
	test.each([false, true])(
		'concurrent guarded report creates serialize without overwrite or forged receipt; different content=%s',
		async (different) => {
			const f = await reportFixture()
			const attempts = [
				{ id: uuidv7(), content: f.content },
				{ id: uuidv7(), content: different ? `${f.content}Distinct evidence.` : f.content },
			]
			const results = await Promise.allSettled(attempts.map((attempt) => f.upsert(attempt.id, attempt.content)))
			const success = results.flatMap((result, index) =>
				result.status === 'fulfilled' ? [{ result: result.value, attempt: attempts[index]! }] : [],
			)
			expect(success).toHaveLength(different ? 1 : 2)
			for (const result of results)
				if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'CONFLICT' })
			const winner = success.find((item) => item.result.created)!
			expect(winner).toBeDefined()
			const state = await f.stored(),
				reports = state.artifacts.filter((item) => item.file_name === f.fileName)
			expect(reports).toHaveLength(1)
			expect(reports[0]).toMatchObject({ id: winner.attempt.id, content: winner.attempt.content })
			expect(state.versions).toHaveLength(0)
			expect(state.logs).toHaveLength(1)
			const loser = attempts.find((item) => item.id !== winner.attempt.id)!
			await expect(f.record(loser.id, loser.content)).rejects.toMatchObject({ code: 'FORBIDDEN' })
			if (different)
				await expect(f.record(winner.attempt.id, loser.content)).rejects.toMatchObject({ code: 'FORBIDDEN' })
			expect(
				(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]!
					.report_receipts,
			).toEqual([])
			expect(await f.record(winner.attempt.id, winner.attempt.content)).toMatchObject({
				receiptIdentity: winner.attempt.id,
			})
			expect(await f.stored()).toEqual(state)
		},
		15_000,
	)
	test.each(['semantic_wake', 'implementation', 'planning'] as const)(
		'reports invalidates fresh readiness after %s without erasing historical return receipts',
		async (change) => {
			const f = await claimFixture()
			const claimed = await f.claim()
			if (claimed.kind !== 'claimed') throw new Error('Expected claim')
			if (!claimed.snapshot.scopeSha256) throw new Error('Expected confirmed scope')
			const outcome = {
				status: 'ready_for_human_approval' as const,
				reason: 'verified_readiness',
				verified: true as const,
				context: {
					repository: f.binding.repository,
					taskId: f.taskId,
					scopeSha256: claimed.snapshot.scopeSha256,
					pr: 7,
					headSha: 'b'.repeat(40),
				},
				continuation: { kind: 'stop' as const },
			}
			await call(
				reviewProgressionProcedures.ack,
				{
					taskId: f.taskId,
					claimId: f.input.claimId,
					generation: claimed.generation,
					claimedRevision: claimed.claimedRevision,
					resultDigest: reviewDigest(outcome),
					validatedOutcome: outcome,
				},
				{ context: f.context },
			)
			const reports = () =>
				call(reviewProgressionProcedures.reports, { taskId: f.taskId }, { context: f.context })
			expect((await reports()).outcome).toEqual(outcome)
			const receipt = {
				requestId: 'a'.repeat(64),
				outcomeKey: 'b'.repeat(64),
				destinationSlot: 'artifact' as const,
				receiptIdentity: uuidv7(),
				contentDigest: 'c'.repeat(64),
			}
			await db
				.update(reviewProgression)
				.set({ report_receipts: [receipt] })
				.where(eq(reviewProgression.task_id, f.taskId))
			if (change === 'semantic_wake') await wakeReviewTask(db, f.organizationId, f.taskId)
			else if (change === 'implementation')
				await call(
					continueSessionProcedure,
					{
						sessionId: f.sessionId,
						eventId: uuidv7(),
						text: 'Resume implementation',
						permissionsMode: 'default',
						executionPhase: 'implementation',
					},
					{ context: apiContext(f) },
				)
			else {
				const patch = { workflowType: 'prd_tdd' as const }
				await call(
					updateTaskProcedure,
					{
						taskId: f.taskId,
						...patch,
						workflowMutation: {
							expectedRevision: '1',
							mutationDigest: reviewDigest(workflowMutationPayload(f.taskId, '1', patch)),
						},
					},
					{ context: apiContext(f) },
				)
			}
			const after = await reports()
			expect(after.outcome).toBeNull()
			expect(after.wakeRevision).not.toBe(claimed.claimedRevision)
			expect(after.receipts).toEqual([receipt])
			expect(after.planningSuspended).toBe(change === 'planning')
			const [retained] = await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))
			expect(retained?.last_outcome).toEqual(change === 'semantic_wake' ? outcome : null)
		},
	)

	async function claimFixture() {
		const f = await idleEnrollment()
		const row = (await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]
		if (!row) throw new Error('Missing enrollment fixture')
		const input = { taskId: f.taskId, expectedWakeRevision: row.wake_revision.toString(), claimId: uuidv7() }
		return {
			...f,
			input,
			claim: (claimId = input.claimId) =>
				call(reviewProgressionProcedures.claim, { ...input, claimId }, { context: f.context }),
		}
	}

	test('conditional progression claims serialize competing daemons and replay the same tuple', async () => {
		const f = await claimFixture()
		const competing = uuidv7()
		const results = await Promise.all([f.claim(), f.claim(competing)])
		expect(results.map((value) => value.kind).sort()).toEqual(['busy', 'claimed'])
		const winnerId = results[0]?.kind === 'claimed' ? f.input.claimId : competing
		const winner = results.find((value) => value.kind === 'claimed')
		expect(await f.claim(winnerId)).toEqual(winner)
		expect((await writerSnapshot(f)).sessions).toHaveLength(1)
	})

	test('expired claims fence renewal and ack; a successor requires writer reconciliation even with idle rows', async () => {
		const f = await claimFixture(),
			first = await f.claim()
		if (first.kind !== 'claimed') throw new Error('Expected claim')
		await db.update(reviewProgression).set({ claim_expires_at: 0n }).where(eq(reviewProgression.task_id, f.taskId))
		const identity = { taskId: f.taskId, claimId: f.input.claimId, generation: first.generation }
		await expect(call(reviewProgressionProcedures.renew, identity, { context: f.context })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		expect(await f.claim()).toEqual({ kind: 'stale' })
		const outcome = {
			status: 'needs_decision' as const,
			reason: 'writer_state_unknown',
			context: null,
			continuation: { kind: 'stop' as const },
		}
		await expect(
			call(
				reviewProgressionProcedures.ack,
				{
					...identity,
					claimedRevision: first.claimedRevision,
					validatedOutcome: outcome,
					resultDigest: reviewDigest(outcome),
				},
				{ context: f.context },
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		const successorId = uuidv7()
		const successor = await f.claim(successorId)
		expect(successor).toMatchObject({
			kind: 'claimed',
			generation: (BigInt(first.generation) + 1n).toString(),
			reconciliationRequired: true,
		})
		expect(await f.claim(successorId)).toEqual(successor)
	})

	test('progression admission observes changed runtime fields without granting another session launch', async () => {
		const f = await claimFixture()
		await db
			.update(sessions)
			.set({ status: 'running', coding_agent_session_id: 'runtime-id' })
			.where(eq(sessions.id, f.sessionId))
		expect(await f.read()).toMatchObject({ kind: 'blocked' })
		expect(await f.claim()).toMatchObject({ kind: 'claimed' })
		expect((await writerSnapshot(f)).sessions).toHaveLength(1)
	})

	test('lease renewal uses database time and does not create semantic wake work', async () => {
		const f = await claimFixture(),
			claimed = await f.claim()
		if (claimed.kind !== 'claimed') throw new Error('Expected claim')
		const before = await writerSnapshot(f)
		const renewed = await call(
			reviewProgressionProcedures.renew,
			{ taskId: f.taskId, claimId: f.input.claimId, generation: claimed.generation },
			{ context: f.context },
		)
		const after = await writerSnapshot(f)
		expect(BigInt(renewed.expiresAt)).toBeGreaterThanOrEqual(BigInt(claimed.expiresAt))
		expect(after.review[0]?.wake_revision).toBe(before.review[0]?.wake_revision)
		expect(after.review[0]?.consumed_revision).toBe(before.review[0]?.consumed_revision)
		expect(after.sessions).toEqual(before.sessions)
	})

	test('ack consumes only its claimed revision, preserves newer work and replays without writes', async () => {
		const f = await claimFixture(),
			claimed = await f.claim()
		if (claimed.kind !== 'claimed') throw new Error('Expected claim')
		await db
			.update(reviewProgression)
			.set({ wake_revision: BigInt(claimed.claimedRevision) + 1n, stage: 'awaiting_delivery' })
			.where(eq(reviewProgression.task_id, f.taskId))
		const outcome = {
			status: 'needs_decision' as const,
			reason: 'writer_state_unknown',
			context: null,
			continuation: { kind: 'stop' as const },
		}
		const input = {
			taskId: f.taskId,
			claimId: f.input.claimId,
			generation: claimed.generation,
			claimedRevision: claimed.claimedRevision,
			resultDigest: reviewDigest(outcome),
			validatedOutcome: outcome,
		}
		expect(await call(reviewProgressionProcedures.ack, input, { context: f.context })).toEqual({
			acknowledged: true,
		})
		const state = await writerSnapshot(f)
		expect(state.review[0]).toMatchObject({
			consumed_revision: BigInt(claimed.claimedRevision),
			wake_revision: BigInt(claimed.claimedRevision) + 1n,
			stage: 'awaiting_delivery',
			claim_id: null,
		})
		expect(await call(reviewProgressionProcedures.ack, input, { context: f.context })).toEqual({
			acknowledged: true,
		})
		expect(await writerSnapshot(f)).toEqual(state)
		await expect(
			call(reviewProgressionProcedures.ack, { ...input, resultDigest: 'f'.repeat(64) }, { context: f.context }),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(await writerSnapshot(f)).toEqual(state)
	})

	test('verified delivery binds the source scope and PR under the current claim and enters review', async () => {
		const f = await claimFixture(),
			claimed = await f.claim()
		if (claimed.kind !== 'claimed' || !claimed.snapshot.scopeSha256) throw new Error('Expected confirmed claim')
		const binding = {
			repository: f.binding.repository,
			branch: f.binding.branch,
			pr: 7,
			headSha: 'a'.repeat(40),
			sourceSessionId: f.sessionId,
			scopeSha256: claimed.snapshot.scopeSha256,
		}
		const outcome = {
			status: 'delivery_observed' as const,
			reason: 'delivery_verified',
			context: {
				repository: binding.repository,
				taskId: f.taskId,
				scopeSha256: binding.scopeSha256,
				pr: binding.pr,
				headSha: binding.headSha,
			},
			continuation: { kind: 'stop' as const },
		}
		const input = {
			taskId: f.taskId,
			claimId: f.input.claimId,
			generation: claimed.generation,
			claimedRevision: claimed.claimedRevision,
			resultDigest: reviewDigest(outcome),
			validatedOutcome: outcome,
			binding,
		}
		expect(await call(reviewProgressionProcedures.recordDelivery, input, { context: f.context })).toEqual(binding)
		expect((await writerSnapshot(f)).review[0]).toMatchObject({ verified_pr_binding: binding, stage: 'reviewing' })
		const recorded = await writerSnapshot(f)
		expect(await call(reviewProgressionProcedures.recordDelivery, input, { context: f.context })).toEqual(binding)
		expect(await writerSnapshot(f)).toEqual(recorded)
		await expect(
			call(
				reviewProgressionProcedures.recordDelivery,
				{ ...input, binding: { ...binding, pr: 8 } },
				{ context: f.context },
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
	})

	test.each(['host', 'owner', 'organization'] as const)(
		'progression APIs and fallback sync reject a different %s',
		async (field) => {
			const f = await claimFixture()
			const auth = {
				...f.context.auth!,
				[field === 'host' ? 'hostId' : field === 'owner' ? 'userId' : 'organizationId']: uuidv7(),
			}
			const context = createMockDaemonContext({
				auth,
				services: { db, dbReadReplica: db, effectRuntime: runtime },
			})
			const before = await writerSnapshot(f)
			await expect(call(reviewProgressionProcedures.claim, f.input, { context })).rejects.toMatchObject({
				code: 'FORBIDDEN',
			})
			expect(await call(syncDaemonReviewProgressionProcedure, {}, { context })).toEqual({ rows: [] })
			expect(await writerSnapshot(f)).toEqual(before)
		},
	)

	function apiContext(
		f: Pick<Awaited<ReturnType<typeof setup>>, 'context' | 'organizationId'>,
		userId = f.context.auth!.userId,
	) {
		return createMockApiContext({
			auth: { organizationId: f.organizationId, userId },
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		})
	}

	async function writerSnapshot(f: { taskId: string }) {
		return {
			approvals: await db.select().from(approvals).where(eq(approvals.task_id, f.taskId)).orderBy(approvals.id),
			task: await db.select().from(tasks).where(eq(tasks.id, f.taskId)),
			review: await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)),
			sessions: await db.select().from(sessions).where(eq(sessions.task_id, f.taskId)).orderBy(sessions.id),
			events: await db
				.select()
				.from(conversationEvents)
				.where(eq(conversationEvents.task_id, f.taskId))
				.orderBy(conversationEvents.id),
			queue: await db
				.select()
				.from(queuedMessages)
				.where(eq(queuedMessages.task_id, f.taskId))
				.orderBy(queuedMessages.id),
		}
	}

	async function enableCollaborator(f: Awaited<ReturnType<typeof idleEnrollment>>) {
		const collaborator = 'fictional-collaborator'
		await db.insert(organizationSettings).values({
			organization_id: f.organizationId,
			multiplayer_prompting_enabled: true,
		})
		await db.insert(taskUserAcl).values({
			task_id: f.taskId,
			organization_id: f.organizationId,
			resource_owner_user_id: f.context.auth!.userId,
			subject_user_id: collaborator,
			permission_level: 'edit',
			granted_by: f.context.auth!.userId,
		})
		await db
			.update(sessions)
			.set({
				multiplayer_prompting_user_ids: [collaborator],
				multiplayer_prompting_started_at: 1n,
				multiplayer_prompting_expires_at: null,
			})
			.where(eq(sessions.id, f.sessionId))
		expect(
			await getSessionAccessControlLevelForClassicProcedure(
				db,
				{
					organizationId: f.organizationId,
					sessionId: f.sessionId,
					actorUserId: collaborator,
				},
				Date.now(),
			),
		).toBe('prompt')
		return collaborator
	}

	async function pendingTools(f: Awaited<ReturnType<typeof idleEnrollment>>) {
		await db.update(sessions).set({ status: 'needs_approval' }).where(eq(sessions.id, f.sessionId))
		for (const tool of ['Edit', 'Bash'])
			await db.insert(approvals).values({
				session_id: f.sessionId,
				task_id: f.taskId,
				organization_id: f.organizationId,
				resource_owner_user_id: f.context.auth!.userId,
				user_id: f.context.auth!.userId,
				host_id: f.context.auth!.hostId,
				tool_name: tool,
				status: 'pending',
			})
	}

	test.each([
		{ model: 'changed-model' },
		{ effort: 'high' },
		{ fastMode: true },
		{ permissionsMode: 'bypass' as const },
		{ permissionsMode: 'accept_edits' as const },
	])(
		'enrolled public execution settings reject a proven prompt collaborator before any effects: %j',
		async (patch) => {
			const f = await idleEnrollment()
			const collaborator = await enableCollaborator(f)
			await pendingTools(f)
			const before = await writerSnapshot(f)
			await expect(
				call(
					updateSessionApiProcedure,
					{ sessionId: f.sessionId, ...patch },
					{
						context: apiContext(f, collaborator),
					},
				),
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				data: { message: 'Could not change execution settings. Ask the task owner to manage enrolled work.' },
			})
			expect(await writerSnapshot(f)).toEqual(before)
			expect(before.approvals).toHaveLength(2)
			expect(before.approvals.every((item) => item.status === 'pending')).toBe(true)
		},
	)

	test.each(['bypass', 'accept_edits'] as const)(
		'enrolled owner retains admitted %s execution control',
		async (permissionsMode) => {
			const f = await idleEnrollment()
			await pendingTools(f)
			const before = await writerSnapshot(f)
			await call(
				updateSessionApiProcedure,
				{ sessionId: f.sessionId, permissionsMode, model: 'owner-selected' },
				{ context: apiContext(f) },
			)
			const state = await writerSnapshot(f)
			expect(state.sessions[0]).toMatchObject({
				permissions_mode: permissionsMode,
				model: 'owner-selected',
				status: permissionsMode === 'bypass' ? 'running' : 'needs_approval',
			})
			expect(state.approvals.find((item) => item.tool_name === 'Edit')?.status).toBe('approved')
			expect(state.approvals.find((item) => item.tool_name === 'Bash')?.status).toBe(
				permissionsMode === 'bypass' ? 'approved' : 'pending',
			)
			expect(state.review).toEqual(before.review)
			expect(state.task).toEqual(before.task)
			expect(state.events).toEqual(before.events)
			expect(state.queue).toEqual(before.queue)
		},
	)

	test('unenrolled public settings preserve stock multiplayer permission and approval behavior', async () => {
		const f = await idleEnrollment()
		await db.delete(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))
		const collaborator = await enableCollaborator(f)
		await pendingTools(f)
		await call(
			updateSessionApiProcedure,
			{ sessionId: f.sessionId, permissionsMode: 'bypass', model: 'collaborator-selected' },
			{ context: apiContext(f, collaborator) },
		)
		const state = await writerSnapshot(f)
		expect(state.sessions[0]).toMatchObject({
			permissions_mode: 'bypass',
			model: 'collaborator-selected',
			status: 'running',
		})
		expect(state.approvals.every((item) => item.status === 'approved')).toBe(true)
		expect(state.review).toEqual([])
	})

	test.each(['action', 'queue', 'sibling', 'resuming', 'planning'] as const)(
		'enrolled owner execution controls cannot bypass %s admission',
		async (blocker) => {
			const f = await idleEnrollment()
			await pendingTools(f)
			if (blocker === 'action')
				await db
					.update(reviewProgression)
					.set({ action_id: uuidv7() })
					.where(eq(reviewProgression.task_id, f.taskId))
			if (blocker === 'planning')
				await db
					.update(reviewProgression)
					.set({ planning_suspended: true })
					.where(eq(reviewProgression.task_id, f.taskId))
			if (blocker === 'resuming')
				await db.update(sessions).set({ status: 'resuming' }).where(eq(sessions.id, f.sessionId))
			if (blocker === 'queue')
				await db.insert(queuedMessages).values({
					id: uuidv7(),
					session_id: f.sessionId,
					task_id: f.taskId,
					organization_id: f.organizationId,
					resource_owner_user_id: f.context.auth!.userId,
					user_id: f.context.auth!.userId,
					content: 'Pending',
				})
			if (blocker === 'sibling')
				await db.insert(sessions).values({
					id: uuidv7(),
					task_id: f.taskId,
					organization_id: f.organizationId,
					resource_owner_user_id: f.context.auth!.userId,
					created_by: f.context.auth!.userId,
					host_id: f.context.auth!.hostId,
					working_directory: f.binding.workingDirectory,
					status: 'running',
				})
			const before = await writerSnapshot(f)
			await expect(
				call(
					updateSessionApiProcedure,
					{ sessionId: f.sessionId, permissionsMode: 'bypass' },
					{ context: apiContext(f) },
				),
			).rejects.toMatchObject({ code: 'CONFLICT' })
			expect(await writerSnapshot(f)).toEqual(before)
		},
	)

	test.each(['legacy', 'v2'] as const)(
		'public %s continuation preserves phase on ordinary input and replays without writes',
		async (version) => {
			const f = await idleEnrollment()
			const input = {
				sessionId: f.sessionId,
				eventId: uuidv7(),
				messageId: uuidv7(),
				text: 'Keep reviewing',
				intent: 'send' as const,
				permissionsMode: 'default' as const,
			}
			const send = (text = input.text) =>
				version === 'legacy'
					? call(continueSessionProcedure, { ...input, text }, { context: apiContext(f) })
					: call(
							continueSessionV2Procedure.withRuntime(runtime),
							{ ...input, text },
							{ context: apiContext(f) },
						)
			const first = await send()
			const before = await writerSnapshot(f)
			expect(before.sessions[0]).toMatchObject({
				task_id: f.taskId,
				execution_phase: 'review',
				execution_phase_at: 1n,
				status: 'resuming',
				prompt: input.text,
			})
			expect(before.review[0]?.writer_receipts).toHaveLength(1)
			expect(await send()).toEqual(first)
			expect(await writerSnapshot(f)).toEqual(before)
			await expect(send('Changed retry')).rejects.toMatchObject({ code: 'CONFLICT' })
			expect(await writerSnapshot(f)).toEqual(before)
		},
	)

	test.each(['legacy', 'v2'] as const)(
		'public %s explicit resume commits one phase, event and admission digest atomically',
		async (version) => {
			const f = await idleEnrollment()
			const input = {
				sessionId: f.sessionId,
				eventId: uuidv7(),
				messageId: uuidv7(),
				text: 'Resume development',
				intent: 'send' as const,
				permissionsMode: 'default' as const,
				executionPhase: 'implementation' as const,
			}
			if (version === 'legacy') await call(continueSessionProcedure, input, { context: apiContext(f) })
			else await call(continueSessionV2Procedure.withRuntime(runtime), input, { context: apiContext(f) })
			const state = await writerSnapshot(f),
				current = state.sessions[0]
			expect(current).toMatchObject({ task_id: f.taskId, execution_phase: 'implementation', status: 'resuming' })
			expect(current?.execution_phase_at).not.toBe(1n)
			expect(state.events).toEqual([
				expect.objectContaining({ id: input.eventId, content: input.text, user_id: f.context.auth!.userId }),
			])
			expect(state.review[0]?.admitted_execution).toEqual({
				sessionId: f.sessionId,
				digest: reviewDigest(reviewExecutionPayload(current!)),
			})
			expect(state.review[0]?.planning_suspended).toBe(false)
		},
	)

	test('two public phase resumes serialize; exactly one request commits without deadlock or partial loser writes', async () => {
		const f = await idleEnrollment()
		const send = () =>
			call(
				continueSessionV2Procedure.withRuntime(runtime),
				{
					sessionId: f.sessionId,
					eventId: uuidv7(),
					messageId: uuidv7(),
					text: 'Resume',
					intent: 'send',
					executionPhase: 'implementation',
				},
				{ context: apiContext(f) },
			)
		const results = await Promise.allSettled([send(), send()])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const state = await writerSnapshot(f)
		expect(state.events).toHaveLength(1)
		expect(state.review[0]?.writer_receipts).toHaveLength(1)
	}, 15_000)

	test.each(['legacy', 'v2'] as const)(
		'public %s phase change rejects a missing event, queued work, and active execution without writes',
		async (version) => {
			const f = await idleEnrollment()
			const input = {
				sessionId: f.sessionId,
				messageId: uuidv7(),
				text: 'Resume',
				intent: 'send' as const,
				permissionsMode: 'default' as const,
				executionPhase: 'implementation' as const,
			}
			const send = (eventId?: string) =>
				version === 'legacy'
					? call(continueSessionProcedure, { ...input, eventId }, { context: apiContext(f) })
					: call(
							continueSessionV2Procedure.withRuntime(runtime),
							{ ...input, eventId },
							{ context: apiContext(f) },
						)
			let before = await writerSnapshot(f)
			await expect(send()).rejects.toMatchObject({ code: 'CONFLICT' })
			expect(await writerSnapshot(f)).toEqual(before)
			await db.insert(queuedMessages).values({
				id: uuidv7(),
				session_id: f.sessionId,
				task_id: f.taskId,
				organization_id: f.organizationId,
				resource_owner_user_id: f.context.auth!.userId,
				user_id: f.context.auth!.userId,
				content: 'Pending',
			})
			before = await writerSnapshot(f)
			await expect(send(uuidv7())).rejects.toMatchObject({ code: 'CONFLICT' })
			expect(await writerSnapshot(f)).toEqual(before)
			await db.delete(queuedMessages).where(eq(queuedMessages.task_id, f.taskId))
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
			before = await writerSnapshot(f)
			await expect(send(uuidv7())).rejects.toMatchObject({ code: 'CONFLICT' })
			expect(await writerSnapshot(f)).toEqual(before)
		},
	)

	test('public V2 continuation rejects an ACL collaborator rather than converting prompt access into enrolled authority', async () => {
		const f = await idleEnrollment()
		const collaborator = await enableCollaborator(f)
		const before = await writerSnapshot(f)
		await expect(
			call(
				continueSessionV2Procedure.withRuntime(runtime),
				{
					sessionId: f.sessionId,
					eventId: uuidv7(),
					messageId: uuidv7(),
					text: 'Resume',
					intent: 'send',
					executionPhase: 'implementation',
				},
				{ context: apiContext(f, collaborator) },
			),
		).rejects.toMatchObject({
			code: 'CONFLICT',
			message: 'Could not start work. Ask the task owner to reconcile its enrolled host and placement.',
		})
		expect(await writerSnapshot(f)).toEqual(before)
	})

	test.each(['legacy', 'v2'] as const)(
		'public %s launch remains admissible after progression acknowledges its exact retained action',
		async (version) => {
			const f = version === 'v2' ? await setupV2() : await idleEnrollment()
			if (version === 'v2') {
				await f.confirm()
				await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.sessionId))
			}
			await db
				.insert(onlineHosts)
				.values({
					host_id: f.context.auth!.hostId,
					user_id: f.context.auth!.userId,
					organization_id: f.organizationId,
				})
				.onConflictDoNothing()
			await db
				.insert(userSettings)
				.values({
					user_id: f.context.auth!.userId,
					organization_id: f.organizationId,
					projects_v2_enabled: true,
				})
				.onConflictDoUpdate({
					target: [userSettings.user_id, userSettings.organization_id],
					set: { projects_v2_enabled: true },
				})
			const sessionId = uuidv7(),
				eventId = uuidv7()
			const input = {
				id: sessionId,
				sessionId,
				eventId,
				taskId: f.taskId,
				title: 'Independent review',
				text: 'Review the accepted delivery',
				workingDirectory: f.binding.workingDirectory,
				hostId: f.context.auth!.hostId,
				codingAgent: 'codelayer' as const,
				provider: 'codex',
				model: 'fixture',
				permissionsMode: 'default' as const,
				executionPhase: 'review' as const,
			}
			const launch = () =>
				'workspaceId' in f
					? call(
							createSessionV2Procedure.withRuntime(runtime),
							{ ...input, workspaceId: f.workspaceId },
							{ context: apiContext(f) },
						)
					: call(launchSessionProcedure, input, { context: apiContext(f) })
			const first = await launch(),
				before = await writerSnapshot(f)
			expect(before.sessions.find((item) => item.id === sessionId)).toMatchObject({
				task_id: f.taskId,
				execution_phase: 'review',
			})
			expect(before.events).toHaveLength(1)
			expect(before.review[0]?.writer_receipts).toHaveLength(1)
			expect(await launch()).toEqual(first)
			expect(await writerSnapshot(f)).toEqual(before)
			const admit = () => call(reviewProgressionProcedures.admission, { sessionId }, { context: f.context })
			const preAck = await admit()
			expect(preAck.kind, preAck.kind === 'blocked' ? preAck.reason : undefined).toBe('enrolled')
			expect(preAck).toMatchObject({ snapshot: { executionSessionId: sessionId } })
			const claimId = uuidv7()
			const claimed = await call(
				reviewProgressionProcedures.claim,
				{ taskId: f.taskId, claimId, expectedWakeRevision: before.review[0]!.wake_revision.toString() },
				{ context: f.context },
			)
			if (claimed.kind !== 'claimed' || !claimed.snapshot.scopeSha256) throw new Error('Expected confirmed claim')
			const outcome = {
				status: 'waiting_writer' as const,
				reason: 'existing_managed_action',
				context: {
					repository: f.binding.repository,
					taskId: f.taskId,
					scopeSha256: claimed.snapshot.scopeSha256,
					pr: null,
					headSha: null,
				},
				continuation: {
					kind: 'wait' as const,
					nextWakeAt: new Date(Date.now() + 300_000).toISOString(),
					actionId: sessionId,
				},
			}
			const acknowledgement = {
				taskId: f.taskId,
				claimId,
				generation: claimed.generation,
				claimedRevision: claimed.claimedRevision,
				resultDigest: reviewDigest(outcome),
				validatedOutcome: outcome,
			}
			expect(await call(reviewProgressionProcedures.ack, acknowledgement, { context: f.context })).toEqual({
				acknowledged: true,
			})
			const acknowledged = await writerSnapshot(f)
			expect(acknowledged).toEqual({
				...before,
				review: [
					expect.objectContaining({
						...before.review[0],
						claim_generation: BigInt(claimed.generation),
						consumed_revision: BigInt(claimed.claimedRevision),
						action_id: sessionId,
						continuation: outcome.continuation,
						next_wake_at: BigInt(Date.parse(outcome.continuation.nextWakeAt)),
						last_outcome: outcome,
						last_ack: {
							claimId,
							generation: claimed.generation,
							revision: claimed.claimedRevision,
							digest: acknowledgement.resultDigest,
						},
						stage: 'awaiting_delivery',
					}),
				],
			})
			const postAck = await admit()
			expect(postAck.kind, postAck.kind === 'blocked' ? postAck.reason : undefined).toBe('enrolled')
			expect(postAck).toMatchObject({ snapshot: { executionSessionId: sessionId } })
			expect(await call(reviewProgressionProcedures.ack, acknowledgement, { context: f.context })).toEqual({
				acknowledged: true,
			})
			expect(await launch()).toEqual(first)
			expect(await writerSnapshot(f)).toEqual(acknowledged)
			await db
				.update(reviewProgression)
				.set({ action_id: uuidv7() })
				.where(eq(reviewProgression.task_id, f.taskId))
			expect(await admit()).toMatchObject({ kind: 'blocked' })
			await db
				.update(reviewProgression)
				.set({
					action_id: sessionId,
					admitted_execution: acknowledged.review[0]!.admitted_execution,
					writer_receipts: [],
				})
				.where(eq(reviewProgression.task_id, f.taskId))
			expect(await admit()).toMatchObject({ kind: 'blocked' })
			await db
				.update(reviewProgression)
				.set({ writer_receipts: acknowledged.review[0]!.writer_receipts })
				.where(eq(reviewProgression.task_id, f.taskId))
			expect(await admit()).toMatchObject({ kind: 'enrolled' })
			await db
				.update(reviewProgression)
				.set({ admitted_execution: { sessionId, digest: 'f'.repeat(64) } })
				.where(eq(reviewProgression.task_id, f.taskId))
			expect(await admit()).toMatchObject({ kind: 'blocked' })
			await db
				.update(reviewProgression)
				.set({ admitted_execution: acknowledged.review[0]!.admitted_execution })
				.where(eq(reviewProgression.task_id, f.taskId))
			expect(
				await call(
					reviewProgressionProcedures.admission,
					{ sessionId },
					{
						context: { ...f.context, auth: { ...f.context.auth!, userId: 'different-owner' } },
					},
				),
			).toMatchObject({ kind: 'blocked' })
			await db.insert(sessions).values({
				id: uuidv7(),
				task_id: f.taskId,
				organization_id: f.organizationId,
				resource_owner_user_id: f.context.auth!.userId,
				created_by: f.context.auth!.userId,
				host_id: f.context.auth!.hostId,
				working_directory: f.binding.workingDirectory,
				status: 'running',
			})
			const competing = await writerSnapshot(f)
			expect(await admit()).toMatchObject({ kind: 'blocked' })
			expect(await writerSnapshot(f)).toEqual(competing)
		},
	)

	test('public legacy launch rolls back session and event when a later workspace check fails', async () => {
		const f = await setupV2()
		await f.confirm()
		await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.sessionId))
		await db.insert(onlineHosts).values({
			host_id: f.hostId,
			user_id: f.userId,
			organization_id: f.organizationId,
			status: 'online',
		})
		const before = await writerSnapshot(f)
		await expect(
			call(
				launchSessionProcedure,
				{
					id: uuidv7(),
					eventId: uuidv7(),
					taskId: f.taskId,
					title: 'Review',
					text: 'Review',
					workingDirectory: f.binding.workingDirectory,
					hostId: f.hostId,
					codingAgent: 'codelayer',
					provider: 'codex',
					model: 'fixture',
					permissionsMode: 'default',
					executionPhase: 'review',
				},
				{ context: apiContext(f) },
			),
		).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			data: { message: 'Project-backed tasks require sessions.v2.create' },
		})
		expect(await writerSnapshot(f)).toEqual(before)
	})

	test('public workflow mutation replays A after B without rebasing, rejects stale/tampered/evicted input, and rolls back late failure', async () => {
		const f = await idleEnrollment()
		const mutation = (
			revision: string,
			patch: Pick<z.input<typeof UpdateTaskInputSchema>, keyof WorkflowPatch>,
		) => ({
			taskId: f.taskId,
			...patch,
			workflowMutation: {
				expectedRevision: revision,
				mutationDigest: reviewDigest(workflowMutationPayload(f.taskId, revision, patch)),
			},
		})
		const a = mutation('1', { workflowType: 'prd_tdd' }),
			b = mutation('2', { workflowType: 'outline_only' })
		const send = (input: typeof a) => call(updateTaskProcedure, input, { context: apiContext(f) })
		const first = await send(a)
		await send(b)
		let before = await writerSnapshot(f)
		expect(await send(a)).toEqual(first)
		expect(await writerSnapshot(f)).toEqual(before)
		await expect(send({ ...a, workflowType: 'freeform' })).rejects.toMatchObject({ code: 'CONFLICT' })
		await expect(send(mutation('1', { workflowType: 'freeform' }))).rejects.toMatchObject({ code: 'CONFLICT' })
		await expect(
			call(
				updateTaskProcedure,
				{ ...mutation('3', { workflowType: 'freeform' }), slug: 'changed-slug' },
				{ context: apiContext(f) },
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		expect(await writerSnapshot(f)).toEqual(before)
		await db
			.update(reviewProgression)
			.set({ workflow_mutation_receipts: [] })
			.where(eq(reviewProgression.task_id, f.taskId))
		before = await writerSnapshot(f)
		await expect(send(a)).rejects.toMatchObject({ code: 'CONFLICT' })
		expect(await writerSnapshot(f)).toEqual(before)
	})

	test.each(['content', 'receipt', 'task'] as const)(
		'public idle V2 drain rejects %s tampering and rolls back all writes',
		async (field) => {
			const f = await idleEnrollment()
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
			const messageId = uuidv7()
			await call(
				continueSessionV2Procedure.withRuntime(runtime),
				{ sessionId: f.sessionId, messageId, eventId: uuidv7(), text: 'Admitted input', intent: 'queue' },
				{ context: apiContext(f) },
			)
			if (field === 'content')
				await db.update(queuedMessages).set({ content: 'Changed' }).where(eq(queuedMessages.id, messageId))
			if (field === 'task')
				await db.update(queuedMessages).set({ task_id: null }).where(eq(queuedMessages.id, messageId))
			if (field === 'receipt')
				await db
					.update(reviewProgression)
					.set({ writer_receipts: [] })
					.where(eq(reviewProgression.task_id, f.taskId))
			await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.sessionId))
			const before = await writerSnapshot(f)
			await expect(
				call(
					continueSessionV2Procedure.withRuntime(runtime),
					{
						sessionId: f.sessionId,
						eventId: uuidv7(),
						messageId: uuidv7(),
						text: 'Ordinary follow-up',
						intent: 'send',
					},
					{ context: apiContext(f) },
				),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' })
			expect(await writerSnapshot(f)).toEqual(before)
			expect((await db.select().from(queuedMessages).where(eq(queuedMessages.id, messageId)))[0]?.status).toBe(
				'pending',
			)
		},
	)

	test('public queued continuation, daemon drain and retry preserve retained evidence and one admitted execution', async () => {
		const f = await idleEnrollment()
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
		const input = {
			sessionId: f.sessionId,
			eventId: uuidv7(),
			messageId: uuidv7(),
			text: 'Admitted input',
			intent: 'interrupt_and_send' as const,
		}
		const send = () => call(continueSessionV2Procedure.withRuntime(runtime), input, { context: apiContext(f) })
		const first = await send()
		await call(updateSessionProcedure, { sessionId: f.sessionId, status: 'interrupted' }, { context: f.context })
		const before = await writerSnapshot(f),
			current = before.sessions[0]
		expect(current).toMatchObject({ status: 'resuming', execution_phase: 'review', prompt: input.text })
		expect(before.queue[0]).toMatchObject({ id: input.messageId, status: 'delivered' })
		expect(before.events).toEqual([expect.objectContaining({ id: input.messageId, content: input.text })])
		expect(before.review[0]?.admitted_execution).toEqual({
			sessionId: f.sessionId,
			digest: reviewDigest(reviewExecutionPayload(current!)),
		})
		expect(await send()).toEqual(first)
		expect(await writerSnapshot(f)).toEqual(before)
	})

	test.each([
		{ status: 'interrupted' as const, keyed: false },
		{ status: 'ready_for_input' as const, keyed: false },
		{ status: 'interrupted' as const, keyed: true },
		{ status: 'ready_for_input' as const, keyed: true },
	])(
		'direct enrolled daemon report retries preserve a pending resume and its remaining queue: %j',
		async ({ status, keyed }) => {
			const f = await idleEnrollment()
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
			await db.insert(userSettings).values({
				user_id: f.context.auth!.userId,
				organization_id: f.organizationId,
				prefer_batch_queue_delivery: false,
			})
			const inputs = [
				{
					sessionId: f.sessionId,
					messageId: uuidv7(),
					eventId: uuidv7(),
					text: 'First input',
					intent: 'queue' as const,
				},
				{
					sessionId: f.sessionId,
					messageId: uuidv7(),
					eventId: uuidv7(),
					text: 'Second input',
					intent: status === 'interrupted' ? ('interrupt_and_send' as const) : ('queue' as const),
				},
			]
			for (const input of inputs)
				await call(continueSessionV2Procedure.withRuntime(runtime), input, { context: apiContext(f) })
			const report = {
				sessionId: f.sessionId,
				status,
				totalCostUsd: 1,
				modelUsage: { fixture: { input_tokens: 10, output_tokens: 2 } },
				usageReportKey: keyed ? uuidv7() : undefined,
			}
			await Promise.all([
				call(updateSessionProcedure, report, { context: f.context }),
				call(updateSessionProcedure, report, { context: f.context }),
			])
			const before = await writerSnapshot(f)
			const delivered = status === 'interrupted' ? inputs[1]! : inputs[0]!
			expect(before.sessions[0]).toMatchObject({
				status: 'resuming',
				prompt: delivered.text,
				execution_phase: 'review',
				execution_phase_at: 1n,
				num_events: 1,
				total_cost_usd: 1,
			})
			expect(before.queue.filter((item) => item.status === 'pending')).toHaveLength(1)
			expect(before.events).toEqual([
				expect.objectContaining({ id: delivered.messageId, content: delivered.text }),
			])
			expect(before.review[0]?.admitted_execution).toEqual({
				sessionId: f.sessionId,
				digest: reviewDigest(reviewExecutionPayload(before.sessions[0]!)),
			})
			await call(updateSessionProcedure, report, { context: f.context })
			expect(await writerSnapshot(f)).toEqual(before)
			await call(updateSessionProcedure, { sessionId: f.sessionId, status: 'running' }, { context: f.context })
			const running = await writerSnapshot(f)
			expect(running.review).toEqual(
				before.review.map((row) => ({ ...row, wake_revision: row.wake_revision + 1n })),
			)
			if (keyed) {
				await call(updateSessionProcedure, report, { context: f.context })
				expect(await writerSnapshot(f)).toEqual(running)
			}
			await call(
				updateSessionProcedure,
				{ ...report, status: 'ready_for_input', usageReportKey: keyed ? uuidv7() : undefined },
				{ context: f.context },
			)
			const drained = await writerSnapshot(f)
			expect(drained.sessions[0]).toMatchObject({
				status: 'resuming',
				num_events: 2,
				execution_phase: 'review',
				execution_phase_at: 1n,
			})
			expect(drained.queue.every((item) => item.status === 'delivered')).toBe(true)
			expect(drained.events).toHaveLength(2)
			expect(drained.review[0]?.writer_receipts).toEqual(before.review[0]?.writer_receipts)
			expect(drained.review[0]?.admitted_execution).toEqual({
				sessionId: f.sessionId,
				digest: reviewDigest(reviewExecutionPayload(drained.sessions[0]!)),
			})
			await call(updateSessionProcedure, { sessionId: f.sessionId, status: 'running' }, { context: f.context })
			const finalReport = {
				...report,
				status: 'ready_for_input' as const,
				usageReportKey: keyed ? uuidv7() : undefined,
			}
			await call(updateSessionProcedure, finalReport, { context: f.context })
			const completed = await writerSnapshot(f)
			expect(completed.sessions[0]).toMatchObject({
				status: 'ready_for_input',
				num_events: 2,
				execution_phase: 'review',
				execution_phase_at: 1n,
				total_cost_usd: keyed ? 3 : 1,
			})
			expect(completed.events).toEqual(drained.events)
			expect(completed.queue).toEqual(drained.queue)
			expect(completed.review).toEqual(
				drained.review.map((row) => ({ ...row, wake_revision: row.wake_revision + 2n })),
			)
			await call(updateSessionProcedure, finalReport, { context: f.context })
			const repeated = await writerSnapshot(f)
			if (!keyed) {
				expect(repeated.sessions[0]!.updated_at).toBeGreaterThanOrEqual(completed.sessions[0]!.updated_at)
				expect(repeated).toEqual({
					...completed,
					sessions: completed.sessions.map((row, index) => ({
						...row,
						updated_at: repeated.sessions[index]!.updated_at,
					})),
				})
			} else expect(repeated).toEqual(completed)
		},
		15_000,
	)

	test('public queue, workflow and daemon drain serialize across operations without losing retained input or admitting planning', async () => {
		const f = await idleEnrollment()
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
		const initial = {
			sessionId: f.sessionId,
			messageId: uuidv7(),
			eventId: uuidv7(),
			text: 'Retained first input',
			intent: 'queue' as const,
		}
		const incoming = { ...initial, messageId: uuidv7(), eventId: uuidv7(), text: 'Concurrent retained input' }
		await call(continueSessionV2Procedure.withRuntime(runtime), initial, { context: apiContext(f) })
		const patch = { workflowType: 'prd_tdd' as const }
		const results = await Promise.allSettled([
			call(continueSessionV2Procedure.withRuntime(runtime), incoming, { context: apiContext(f) }),
			call(
				updateTaskProcedure,
				{
					taskId: f.taskId,
					...patch,
					workflowMutation: {
						expectedRevision: '1',
						mutationDigest: reviewDigest(workflowMutationPayload(f.taskId, '1', patch)),
					},
				},
				{ context: apiContext(f) },
			),
			call(updateSessionProcedure, { sessionId: f.sessionId, status: 'ready_for_input' }, { context: f.context }),
		])
		expect(results[0]?.status).toBe('fulfilled')
		expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } })
		expect(results[2]?.status).toBe('fulfilled')
		let state = await writerSnapshot(f)
		expect(state.sessions).toHaveLength(1)
		expect(state.sessions[0]?.status).toBe('resuming')
		expect(state.task[0]).toMatchObject({ workflow_type: 'freeform', workflow_revision: 1n })
		expect(state.review[0]).toMatchObject({ planning_suspended: false, workflow_mutation_receipts: [] })
		expect(state.review[0]?.writer_receipts).toHaveLength(2)
		expect(state.queue).toHaveLength(2)
		expect(state.events.length).toBe(state.queue.filter((item) => item.status === 'delivered').length)
		expect(state.review[0]?.admitted_execution).toEqual({
			sessionId: f.sessionId,
			digest: reviewDigest(reviewExecutionPayload(state.sessions[0]!)),
		})
		await call(updateSessionProcedure, { sessionId: f.sessionId, status: 'running' }, { context: f.context })
		await call(
			updateSessionProcedure,
			{ sessionId: f.sessionId, status: 'ready_for_input' },
			{ context: f.context },
		)
		state = await writerSnapshot(f)
		expect(state.events).toHaveLength(2)
		expect(state.events.map((item) => item.id).sort()).toEqual([initial.messageId, incoming.messageId].sort())
		expect(state.queue.every((item) => item.status === 'delivered')).toBe(true)
		expect(state.sessions[0]).toMatchObject({ num_events: 2, execution_phase: 'review', execution_phase_at: 1n })
		expect(state.review[0]?.writer_receipts).toHaveLength(2)
	}, 15_000)

	for (const competingWriter of ['legacy_continue', 'internal_successor'] as const) {
		test(`${competingWriter} races repair launch and workflow mutation without a second writer`, async () => {
			const f = await idleEnrollment()
			await db.insert(onlineHosts).values({
				host_id: f.context.auth!.hostId,
				user_id: f.context.auth!.userId,
				organization_id: f.organizationId,
			})
			if (competingWriter === 'internal_successor') {
				await db
					.update(tasks)
					.set({ workflow_type: 'rpi', worktree_timing: 'never', auto_advance_plan_to_worktree: true })
					.where(eq(tasks.id, f.taskId))
				await db
					.update(sessions)
					.set({
						labels: [{ name: 'rpi:plan', title: 'plan' }],
						next_step_suggestions: [
							{
								parsedAt: 0,
								extraction: {
									type: 'next_step_found',
									nextStepType: 'implement-plan',
									nextStepPrompt: 'Implement',
									nextStepSummary: 'Implement',
									taskReference: 'delivery',
								},
							},
						],
					})
					.where(eq(sessions.id, f.sessionId))
			}
			const before = await writerSnapshot(f)
			const repair = {
				id: uuidv7(),
				eventId: uuidv7(),
				taskId: f.taskId,
				hostId: f.context.auth!.hostId,
				title: 'Repair fixture',
				text: 'Authorized repair fixture',
				workingDirectory: f.binding.workingDirectory,
				codingAgent: 'codelayer' as const,
				provider: 'codex',
				model: 'fixture',
				permissionsMode: 'default' as const,
				executionPhase: 'implementation' as const,
			}
			const continuation = {
				sessionId: f.sessionId,
				eventId: uuidv7(),
				text: 'Resume implementation',
				intent: 'send' as const,
				executionPhase: 'implementation' as const,
			}
			const patch = { workflowType: 'prd_tdd' as const }
			const workflow = {
				taskId: f.taskId,
				...patch,
				workflowMutation: {
					expectedRevision: '1',
					mutationDigest: reviewDigest(workflowMutationPayload(f.taskId, '1', patch)),
				},
			}
			const results = await Promise.allSettled([
				call(launchSessionProcedure, repair, { context: apiContext(f) }),
				competingWriter === 'legacy_continue'
					? call(continueSessionProcedure, continuation, { context: apiContext(f) })
					: checkAutoAdvance(db, f.sessionId, f.organizationId),
				call(updateTaskProcedure, workflow, { context: apiContext(f) }),
			])
			const after = await writerSnapshot(f)
			const runnable = after.sessions.filter(
				(session) => !['draft', 'ready_for_input', 'interrupted'].includes(session.status),
			)
			expect(runnable).toHaveLength(1)
			expect(after.review[0]?.writer_receipts).toHaveLength(1)
			expect(after.events).toHaveLength(before.events.length + 1)
			expect(after.queue).toEqual(before.queue)
			expect(after.review[0]?.writer_receipts[0]?.sessionId).toBe(runnable[0]!.id)
			expect(after.review[0]?.admitted_execution).toEqual({
				sessionId: runnable[0]!.id,
				digest: reviewDigest(reviewExecutionPayload(runnable[0]!)),
			})
			const workflowWon = results[2]!.status === 'fulfilled'
			for (const result of results) {
				if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'CONFLICT' })
			}
			expect(after.task[0]?.workflow_type).toBe(
				workflowWon ? 'prd_tdd' : competingWriter === 'internal_successor' ? 'rpi' : 'freeform',
			)
			expect(after.review[0]?.workflow_mutation_receipts).toHaveLength(workflowWon ? 1 : 0)
			if (competingWriter === 'legacy_continue') {
				expect(results.slice(0, 2).filter((result) => result.status === 'fulfilled')).toHaveLength(1)
			} else if (workflowWon) {
				// Planning suspends implicit internal implementation, not a new explicit owner repair.
				expect(runnable[0]!.id).toBe(repair.id)
				expect(after.review[0]?.writer_receipts[0]?.key).not.toContain('auto-advance')
			}
			const stable = await writerSnapshot(f)
			if (workflowWon) await call(updateTaskProcedure, workflow, { context: apiContext(f) })
			else
				await expect(call(updateTaskProcedure, workflow, { context: apiContext(f) })).rejects.toMatchObject({
					code: 'CONFLICT',
				})
			expect(await writerSnapshot(f)).toEqual(stable)
		}, 15_000)
	}

	test('internal planning successors serialize and consume their workflow flag with one retained admission', async () => {
		const f = await idleEnrollment()
		await db
			.update(tasks)
			.set({ workflow_type: 'rpi', auto_advance_questions_to_research: true })
			.where(eq(tasks.id, f.taskId))
		await db
			.update(sessions)
			.set({ labels: [{ name: 'rpi:research-questions', title: 'questions' }], execution_phase: null })
			.where(eq(sessions.id, f.sessionId))
		await db
			.update(artifacts)
			.set({ frontmatter: { type: 'research-questions' } })
			.where(eq(artifacts.task_id, f.taskId))
		await Promise.all([
			checkAutoAdvance(db, f.sessionId, f.organizationId),
			checkAutoAdvance(db, f.sessionId, f.organizationId),
		])
		const state = await writerSnapshot(f)
		expect(state.sessions).toHaveLength(2)
		expect(state.sessions.find((item) => item.id !== f.sessionId)).toMatchObject({
			execution_phase: null,
			labels: [{ name: 'rpi:research', title: 'research' }],
		})
		expect(state.task[0]).toMatchObject({ auto_advance_questions_to_research: false, workflow_revision: 2n })
		expect(state.review[0]?.writer_receipts).toHaveLength(1)
	}, 15_000)

	test('internal implementation and Describe PR successors cannot bypass planning suspension or enrolled same-session delivery', async () => {
		const f = await idleEnrollment()
		await db
			.update(tasks)
			.set({
				workflow_type: 'rpi',
				worktree_timing: 'never',
				auto_advance_plan_to_worktree: true,
				auto_advance_implementation_to_pr: true,
			})
			.where(eq(tasks.id, f.taskId))
		await db
			.update(reviewProgression)
			.set({ planning_suspended: true })
			.where(eq(reviewProgression.task_id, f.taskId))
		await db
			.update(sessions)
			.set({
				labels: [{ name: 'rpi:plan', title: 'plan' }],
				execution_phase: null,
				next_step_suggestions: [
					{
						parsedAt: 0,
						extraction: {
							type: 'next_step_found',
							nextStepType: 'implement-plan',
							nextStepPrompt: 'Implement',
							nextStepSummary: 'Implement',
							taskReference: 'delivery',
						},
					},
				],
			})
			.where(eq(sessions.id, f.sessionId))
		let before = await writerSnapshot(f)
		await checkAutoAdvance(db, f.sessionId, f.organizationId)
		expect(await writerSnapshot(f)).toEqual(before)
		await db
			.update(sessions)
			.set({
				labels: [{ name: 'rpi:implementation', title: 'implementation' }],
				execution_phase: 'implementation',
			})
			.where(eq(sessions.id, f.sessionId))
		before = await writerSnapshot(f)
		await checkAutoAdvance(db, f.sessionId, f.organizationId)
		expect(await writerSnapshot(f)).toEqual(before)
	})

	test('retains exact continuation evidence and bigint-safe results; replay cannot rewrite phase or accept tampering', async () => {
		const f = await idleEnrollment(),
			eventId = uuidv7(),
			messageId = uuidv7()
		const request = {
			sessionId: f.sessionId,
			eventId,
			messageId,
			text: 'Resume the accepted work',
			intent: 'send',
			executionPhase: 'implementation' as const,
		}
		const input = {
			userId: 'fictional-owner',
			hostId: f.context.auth!.hostId,
			sessionId: f.sessionId,
			eventId,
			messageId,
			kind: 'v2.continue',
			request,
			entry: request,
			continuing: true,
		}
		await db.transaction(async (tx) => {
			const boundary = await lockReviewTask(tx, f.organizationId, f.taskId)
			const started = await beginReviewWriter(tx, boundary, input)
			await tx
				.update(sessions)
				.set({ status: 'resuming', ...reviewWorkEntry(request, 'freeform') })
				.where(eq(sessions.id, f.sessionId))
			await tx.insert(conversationEvents).values({
				id: eventId,
				session_id: f.sessionId,
				task_id: f.taskId,
				organization_id: f.organizationId,
				resource_owner_user_id: input.userId,
				user_id: input.userId,
				event_type: 'message',
				role: 'user',
				content: request.text,
			})
			await finishReviewWriter(tx, boundary, started, {
				...request,
				entry: request,
				result: {
					kind: 'continued',
					transactionId: 'retained',
					nested: { timestamp: 123n, omitted: undefined },
				},
			})
		})
		const before = await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))
		const replay = () =>
			db.transaction(async (tx) =>
				beginReviewWriter(tx, await lockReviewTask(tx, f.organizationId, f.taskId), input),
			)
		expect((await replay())?.replay).toEqual({
			kind: 'continued',
			transactionId: 'retained',
			nested: { timestamp: '123' },
		})
		expect(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))).toEqual(before)
		await expect(
			db.transaction(async (tx) =>
				beginReviewWriter(tx, await lockReviewTask(tx, f.organizationId, f.taskId), {
					...input,
					request: { ...request, text: 'Changed' },
				}),
			),
		).rejects.toMatchObject({ code: 'CONFLICT' })
		await db.insert(queuedMessages).values({
			id: messageId,
			session_id: f.sessionId,
			task_id: f.taskId,
			organization_id: f.organizationId,
			resource_owner_user_id: input.userId,
			user_id: input.userId,
			content: 'Tampered queue',
			status: 'delivered',
		})
		await expect(replay()).rejects.toMatchObject({ code: 'CONFLICT' })
	})

	test('an enrolled phase transition rejects queued work, absent IDs and competing writers without writes', async () => {
		const f = await idleEnrollment(),
			eventId = uuidv7(),
			messageId = uuidv7()
		const request = { text: 'Resume', executionPhase: 'implementation' as const }
		const input = {
			userId: 'fictional-owner',
			hostId: f.context.auth!.hostId,
			sessionId: f.sessionId,
			eventId,
			messageId,
			kind: 'v2.continue',
			request,
			entry: request,
			continuing: true,
		}
		const admit = (override = {}) =>
			db.transaction(async (tx) =>
				beginReviewWriter(tx, await lockReviewTask(tx, f.organizationId, f.taskId), { ...input, ...override }),
			)
		await expect(admit({ messageId: undefined })).rejects.toMatchObject({ code: 'CONFLICT' })
		await expect(admit({ userId: 'collaborator' })).rejects.toMatchObject({ code: 'CONFLICT' })
		await db.insert(queuedMessages).values({
			id: messageId,
			session_id: f.sessionId,
			task_id: f.taskId,
			organization_id: f.organizationId,
			resource_owner_user_id: input.userId,
			user_id: input.userId,
			content: 'Pending work',
		})
		await expect(admit()).rejects.toMatchObject({ code: 'CONFLICT' })
		await db.delete(queuedMessages).where(eq(queuedMessages.id, messageId))
		await db.update(reviewProgression).set({ action_id: uuidv7() }).where(eq(reviewProgression.task_id, f.taskId))
		await expect(admit()).rejects.toMatchObject({ code: 'CONFLICT' })
		expect((await db.select().from(sessions).where(eq(sessions.id, f.sessionId)))[0]).toMatchObject({
			status: 'ready_for_input',
			execution_phase: 'review',
			execution_phase_at: 1n,
		})
	})

	test('workflow A replay preserves a later B mutation and rejects changed, stale, or unauthorized requests', async () => {
		const f = await idleEnrollment()
		const mutation = (revision: string, patch: WorkflowPatch) => ({
			taskId: f.taskId,
			...patch,
			workflowMutation: {
				expectedRevision: revision,
				mutationDigest: reviewDigest(workflowMutationPayload(f.taskId, revision, patch)),
			},
		})
		const a = mutation('1', { workflowType: 'prd_tdd' }),
			b = mutation('2', { workflowType: 'outline_only' })
		const apply = (input: typeof a, result: string, userId = 'fictional-owner') =>
			db.transaction(async (tx) => {
				const boundary = await lockReviewTask(tx, f.organizationId, f.taskId)
				const started = await beginReviewWorkflow(tx, boundary, userId, input)
				if (started?.replay) return started.replay
				await tx
					.update(tasks)
					.set({ workflow_type: input.workflowType as 'prd_tdd' | 'outline_only' })
					.where(eq(tasks.id, f.taskId))
				const receipt = { transactionId: result, success: true }
				await finishReviewWorkflow(tx, boundary, started, receipt, input)
				return receipt
			})
		await apply(a, 'A')
		await apply(b, 'B')
		const before = await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))
		expect(await apply(a, 'wrong')).toEqual({ transactionId: 'A', success: true })
		expect((await db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]).toMatchObject({
			workflow_type: 'outline_only',
			workflow_revision: 3n,
			auto_advance_implementation_to_pr: false,
		})
		expect(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))).toEqual(before)
		await expect(apply({ ...a, workflowType: 'freeform' }, 'tampered')).rejects.toMatchObject({ code: 'CONFLICT' })
		await expect(apply(mutation('1', { workflowType: 'freeform' }), 'stale')).rejects.toMatchObject({
			code: 'CONFLICT',
		})
		await expect(
			apply(mutation('3', { workflowType: 'freeform' }), 'foreign', 'collaborator'),
		).rejects.toMatchObject({ code: 'CONFLICT' })
		await db
			.update(reviewProgression)
			.set({ workflow_mutation_receipts: [] })
			.where(eq(reviewProgression.task_id, f.taskId))
		await expect(apply(a, 'evicted')).rejects.toMatchObject({ code: 'CONFLICT' })
	})

	test('V2 confirms only the current materialization and atomically exposes the distinct helper scope to its source', async () => {
		const f = await setupV2()
		expect(await f.read()).toMatchObject({
			kind: 'enrolled',
			snapshot: { setupComplete: true, scopeSha256: null, verifiedBinding: null },
		})
		await f.confirm()
		const result = await f.read()
		if (result.kind !== 'enrolled') throw new Error('Expected enrolled fixture')
		const scope = reviewDigest(reviewHelperScope(result.snapshot.scopeInputs, f.binding))
		expect(result.snapshot.scopeSha256).toBe(scope)
		expect(scope).not.toBe(f.confirmation.acceptedLaunchDigest)
		const [artifact] = await db
			.select()
			.from(artifacts)
			.where(eq(artifacts.file_name, reviewDeliveryContextFile(f.sessionId)))
		expect(JSON.parse(artifact!.content)).toEqual({
			version: 1,
			taskId: f.taskId,
			sourceId: f.sessionId,
			acceptedLaunchDigest: f.confirmation.acceptedLaunchDigest,
			scopeSha256: scope,
		})
		const [before] = await db.select().from(tasks).where(eq(tasks.id, f.taskId))
		await f.confirm()
		expect((await db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!.updated_at).toBe(before!.updated_at)
		await db.update(artifacts).set({ content: '{}' }).where(eq(artifacts.id, artifact!.id))
		expect(await f.read()).toMatchObject({ kind: 'blocked' })
	})
	test.each(['v2', 'legacy_spec', 'legacy_in_place'] as const)(
		'%s binds the admission digest to the exact source execution payload',
		async (placement) => {
			const f = placement === 'v2' ? await setupV2() : await setup(placement === 'legacy_spec')
			const [session] = await db.select().from(sessions).where(eq(sessions.id, f.sessionId))
			expect(await f.read()).toMatchObject({
				kind: 'enrolled',
				snapshot: { executionDigest: reviewDigest(reviewExecutionPayload(session!)) },
			})
			for (const changes of [
				{ prompt: 'Changed instructions' },
				{ effort: 'changed' },
				{ fast_mode: true },
				{ permissions_mode: 'bypass' },
				{ fork_data: { fork: 'unaccepted' } },
				{ coding_agent_session_id: 'existing-agent' },
				{ task_id: null },
			] satisfies Partial<typeof sessions.$inferInsert>[]) {
				await db.update(sessions).set(changes).where(eq(sessions.id, f.sessionId))
				expect(await f.read()).toMatchObject({ kind: 'blocked' })
				await db
					.update(sessions)
					.set({
						prompt: session!.prompt,
						effort: session!.effort,
						fast_mode: session!.fast_mode,
						permissions_mode: session!.permissions_mode,
						fork_data: session!.fork_data,
						coding_agent_session_id: session!.coding_agent_session_id,
						task_id: session!.task_id,
					})
					.where(eq(sessions.id, f.sessionId))
			}
			expect(await f.read()).toMatchObject({
				kind: 'enrolled',
				snapshot: { executionDigest: reviewDigest(reviewExecutionPayload(session!)) },
			})
		},
	)
	test.each(['generation', 'materialization', 'host', 'owner', 'recipe', 'running'] as const)(
		'V2 refuses confirmation after %s drift',
		async (field) => {
			const f = await setupV2()
			if (field === 'generation')
				await db
					.update(locations)
					.set({ setup_generation: 2n })
					.where(eq(locations.workspace_id, f.workspaceId))
			if (field === 'materialization')
				await db.update(statuses).set({ materialization: null }).where(eq(statuses.workspace_id, f.workspaceId))
			if (field === 'host')
				await db.update(statuses).set({ host_id: 'other-host' }).where(eq(statuses.workspace_id, f.workspaceId))
			if (field === 'owner')
				await db
					.update(workspaces)
					.set({ resource_owner_user_id: 'other-owner' })
					.where(eq(workspaces.id, f.workspaceId))
			if (field === 'recipe')
				await db
					.update(workspaces)
					.set({ repositories: f.repositories.map((repo) => ({ ...repo, branch: 'changed' })) })
					.where(eq(workspaces.id, f.workspaceId))
			if (field === 'running')
				await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.sessionId))
			await expect(f.confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
			expect(
				(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]!
					.verified_binding,
			).toBeNull()
			expect(
				await db
					.select()
					.from(artifacts)
					.where(eq(artifacts.file_name, reviewDeliveryContextFile(f.sessionId))),
			).toEqual([])
		},
	)
	test('conflicting preexisting delivery evidence rolls back binding confirmation', async () => {
		const f = await setupV2()
		await db.insert(artifacts).values({
			task_id: f.taskId,
			organization_id: f.organizationId,
			resource_owner_user_id: f.userId,
			created_by: f.userId,
			file_name: reviewDeliveryContextFile(f.sessionId),
			content: '{}',
			content_hash: hash('{}'),
		})
		await expect(f.confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(
			(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId)))[0]!
				.verified_binding,
		).toBeNull()
	})
	test('pins imported ticket text, legacy image bytes and upload bytes without trusting provider hash algorithms', async () => {
		const organizationId = uuidv7(),
			taskId = uuidv7(),
			bytes = Buffer.from('image')
		const sha = createHash('sha256').update(bytes).digest('hex')
		const base = {
			taskId,
			organizationId,
			taskContent: 'Accepted task',
			attachments: [
				{
					fileName: 'upload.bin',
					contentType: 'application/octet-stream',
					fileSizeBytes: bytes.length,
					contentHash: sha,
				},
			],
			importedTicket: {
				label: 'T-1',
				fileName: 'ticket.md',
				content: 'Accepted imported criteria',
				contentHash: hash('Accepted imported criteria'),
				images: [
					{
						fileName: 'ticket.png',
						contentType: 'image/png',
						fileSizeBytes: bytes.length,
						contentHash: hash(bytes.toString('base64')),
						s3Key: `${organizationId}/${taskId}/provider-imports/attempt/ticket.png`,
					},
				],
			},
		}
		const s3 = {
			getPresignedDownloadUrl: async () => 'https://fictional.invalid/object',
			getPresignedUploadUrl: async () => {
				throw new Error('No uploads')
			},
		}
		const download = async () => new Response(bytes)
		const manifest = await prepareReviewArtifacts(base, s3, download)
		expect(manifest.filter((item) => item.storageType === 's3').every((item) => item.bytesSha256 === sha)).toBe(
			true,
		)
		const accepted = acceptedReviewLaunch({
			...base,
			reviewProgressionEnrollment: { enrollmentId: 'personal', returnRouteRef: 'origin' },
			preparedReviewArtifacts: manifest,
		})
		const changed = await prepareReviewArtifacts(
			{ ...base, importedTicket: { ...base.importedTicket, content: 'Changed imported criteria' } },
			s3,
			download,
		)
		expect(canonicalReviewValue(changed)).not.toBe(canonicalReviewValue(manifest))
		expect(accepted.acceptedArtifacts).toEqual(manifest)
		await expect(prepareReviewArtifacts(base, s3, async () => new Response('other'))).rejects.toThrow(
			'accepted_binary_content_changed',
		)
		await expect(
			prepareReviewArtifacts({ ...base, attachments: [...base.attachments, base.attachments[0]!] }, s3, download),
		).rejects.toThrow('ambiguous_accepted_artifacts')
		await expect(
			prepareReviewArtifacts(
				{ ...base, attachments: [{ ...base.attachments[0]!, fileName: '../outside' }] },
				s3,
				download,
			),
		).rejects.toThrow()
	})

	test.each([false, true])(
		'confirms and rereads real legacy placement with spec=%s; identical confirmation is inert',
		async (spec) => {
			const f = await setup(spec)
			expect(await f.read()).toMatchObject({
				kind: 'enrolled',
				snapshot: {
					setupComplete: true,
					verifiedBinding: null,
					placement: {
						kind: 'legacy_directory',
						projectId: null,
						workspaceId: null,
						setupRowId: f.setupRowId,
					},
				},
			})
			expect(await f.confirm()).toEqual(f.binding)
			const before = await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))
			expect(await f.confirm()).toEqual(f.binding)
			expect(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))).toEqual(
				before,
			)
			expect(await f.read()).toMatchObject({
				kind: 'enrolled',
				snapshot: { verifiedBinding: f.binding, bindingDigest: reviewDigest(f.binding) },
			})
			const changed = { ...f.binding, branch: 'codex/other' }
			await expect(
				call(
					reviewProgressionProcedures.confirmPlacement,
					{ ...f.confirmation, binding: changed, bindingDigest: reviewDigest(changed) },
					{ context: f.context },
				),
			).rejects.toMatchObject({ code: 'FORBIDDEN' })
		},
	)
	test('blocks foreign ownership/host and changed accepted artifact without fabricating another row', async () => {
		const f = await setup()
		for (const auth of [
			{ ...f.context.auth!, hostId: 'other' },
			{ ...f.context.auth!, userId: 'other' },
			{ ...f.context.auth!, organizationId: uuidv7() },
		]) {
			expect(
				await call(
					reviewProgressionProcedures.admission,
					{ sessionId: f.sessionId },
					{ context: { ...f.context, auth } },
				),
			).toMatchObject({ kind: 'blocked' })
		}
		await db.update(artifacts).set({ content: 'Changed acceptance' }).where(eq(artifacts.task_id, f.taskId))
		expect(await f.read()).toMatchObject({ kind: 'blocked' })
		await expect(f.confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(await db.select().from(reviewProgression).where(eq(reviewProgression.task_id, f.taskId))).toEqual([
			expect.objectContaining({ verified_binding: null }),
		])
	})
	test('does not confirm incomplete or drifted setup and does not enroll an absent task', async () => {
		const f = await setup(true)
		await db
			.update(taskWorkspaceSetupForHost)
			.set({ status: 'setup_requested' })
			.where(eq(taskWorkspaceSetupForHost.id, f.setupRowId))
		expect(await f.read()).toMatchObject({ kind: 'enrolled', snapshot: { setupComplete: false } })
		await expect(f.confirm()).rejects.toMatchObject({ code: 'FORBIDDEN' })
		await db
			.update(taskWorkspaceSetupForHost)
			.set({ status: 'done', resolved_workspace_spec: null })
			.where(eq(taskWorkspaceSetupForHost.id, f.setupRowId))
		expect(await f.read()).toMatchObject({ kind: 'blocked' })
		await expect(
			call(
				reviewProgressionProcedures.confirmPlacement,
				{ ...f.confirmation, taskId: uuidv7() },
				{ context: f.context },
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
	})
	test('accepts the bridge same-session wording without requiring a byte-identical UI template', () => {
		const text =
			'Publish in this same session with a separate DeliveryReportV1; independent review is separate. No merge authority.'
		const request = {
			taskId: uuidv7(),
			workspaceId: uuidv7(),
			sessionId: uuidv7(),
			eventId: uuidv7(),
			projectId: uuidv7(),
			name: 'Delivery',
			slug: 'delivery',
			repositories: [
				{
					remoteUrl: 'https://github.com/example/product.git',
					repositoryIdentity: 'github.com/example/product',
					defaultBranch: 'main',
					branch: 'codex/delivery',
					default: true,
					autoPushBranch: false,
					copyGlobs: [],
				},
			],
			taskContent: text,
			reviewProgressionEnrollment: { enrollmentId: 'personal', returnRouteRef: 'origin_1' },
			firstSession: {
				text,
				hostId: 'host',
				codingAgent: 'codelayer',
				provider: 'codex',
				model: 'fictional-model',
				permissionsMode: 'default',
				intent: 'implementation',
			},
		}
		expect(CreateTaskV2InputSchema.safeParse(request).success).toBe(true)
		expect(CreateTaskV2InputSchema.safeParse({ ...request, autoAdvanceImplementationToPr: true }).success).toBe(
			false,
		)
		expect(
			CreateTaskV2InputSchema.safeParse({
				...request,
				firstSession: { ...request.firstSession, text: `${text}\n/rpi:describe-pr` },
			}).success,
		).toBe(false)
	})
})

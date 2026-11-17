import { artifacts } from '@humanlayer/db/tables/artifacts'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizations } from '@humanlayer/db/tables/organizations'
import { projects } from '@humanlayer/db/tables/projects'
import { repositoryLocationsForUserForHost } from '@humanlayer/db/tables/repository-locations-for-user-for-host'
import { sessionRepositories } from '@humanlayer/db/tables/session-repositories'
import { sessions } from '@humanlayer/db/tables/sessions'
import { taskLaunches } from '@humanlayer/db/tables/task-launches'
import { tasks } from '@humanlayer/db/tables/tasks'
import { userSettings } from '@humanlayer/db/tables/user-settings'
import { workspaceLocationsForUserForHost } from '@humanlayer/db/tables/workspace-locations-for-user-for-host'
import { workspaceRepositoryStatusForUserForHost } from '@humanlayer/db/tables/workspace-repository-status-for-user-for-host'
import { workspaces } from '@humanlayer/db/tables/workspaces'
import { ORPCError } from '@orpc/client'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer } from 'effect'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { lockDeliveryTask } from '../../src/db/automatic-delivery'
import { enrollProjectDelivery } from '../../src/db/project-delivery'
import {
	type GenerateSessionTitleInput,
	SessionTitleGeneration,
} from '../../src/effects/services/session-title-generation/session-title-generation.service'
import { createTaskV2Procedure as liveCreateTaskV2 } from '../../src/orpc/api/tasks/v2/create.effect'
import { claimDeliveryProcedure } from '../../src/orpc/daemon/delivery'
import {
	createMockApiContext,
	createMockDaemonAuth,
	createMockDaemonContext,
	createMockJiraService,
	createMockLinearService,
	createMockS3Service,
	createMockStripeService,
	createMockWorkosService,
} from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const repository = {
	remoteUrl: 'git@github.com:humanlayer/syncopate.git',
	repositoryIdentity: 'github.com/humanlayer/syncopate',
	defaultBranch: 'main',
	branch: 'workspace-test',
	default: true as const,
	autoPushBranch: false,
	copyGlobs: [] as string[],
}

describe('tasks v2 create', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let createTaskV2: typeof liveCreateTaskV2
	const scheduledTitleGenerations: GenerateSessionTitleInput[] = []

	const services = {
		workos: createMockWorkosService(),
		stripe: createMockStripeService(),
		s3: createMockS3Service(),
		linear: createMockLinearService({
			getIssue: async (_orgId: string, ticketId: string) => ({
				identifier: ticketId,
				title: `Test issue ${ticketId}`,
				url: `https://linear.app/test/issue/${ticketId}`,
				branch: null,
				status: 'Todo',
				assignee: null,
				description: `Description for ${ticketId}`,
				comments: [],
				parents: [],
			}),
			getAccessToken: async () => 'mock-linear-access-token',
		}),
		get db() {
			return db
		},
		get dbReadReplica() {
			return db
		},
	}

	beforeAll(async () => {
		const testDb = await createTestDb('tasks-v2-create')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db, {
			sessionTitleGeneration: Layer.succeed(SessionTitleGeneration, {
				scheduleGeneration: (input) =>
					Effect.promise(async () => {
						const [session] = await db.select().from(sessions).where(eq(sessions.id, input.sessionId))
						expect(session).toMatchObject({ title: null, prompt: input.prompt })
						scheduledTitleGenerations.push(input)
					}),
			}),
		})
		createTaskV2 = bindProcedureToRuntime(liveCreateTaskV2, runtime)
	}, 60_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	}, 30_000)

	beforeEach(() => {
		scheduledTitleGenerations.length = 0
	})

	async function setupActor(enabled = true, projectRepository = repository) {
		const organizationId = uuidv7()
		const userId = `user-${uuidv7()}`
		const hostId = `host-${uuidv7()}`
		const projectId = uuidv7()
		await db
			.insert(organizations)
			.values({ id: organizationId, name: 'V2 task test', workos_organization_id: `workos-${organizationId}` })
		await db
			.insert(userSettings)
			.values({ organization_id: organizationId, user_id: userId, projects_v2_enabled: enabled })
		await db
			.insert(onlineHosts)
			.values({ organization_id: organizationId, user_id: userId, host_id: hostId, status: 'online' })
		await db.insert(projects).values({
			id: projectId,
			organization_id: organizationId,
			name: 'Test project',
			created_by: userId,
			resource_owner_user_id: userId,
			repositories: [{ ...projectRepository, default: true }],
		})
		await db.insert(repositoryLocationsForUserForHost).values({
			organization_id: organizationId,
			user_id: userId,
			host_id: hostId,
			repository_identity: repository.repositoryIdentity,
			source_kind: 'filesystem',
			source_path: '/home/user/projects/syncopate',
		})
		const auth = {
			userId,
			organizationId,
			workosOrganizationId: `workos-${organizationId}`,
			role: '',
			roles: [] as string[],
			permissions: [] as string[],
			entitlements: [] as string[],
			sessionId: 'session',
		}
		return { organizationId, userId, hostId, projectId, context: createMockApiContext({ auth, services }) }
	}

	async function setupCollaborator(actor: Awaited<ReturnType<typeof setupActor>>) {
		const userId = `user-${uuidv7()}`
		const hostId = `host-${uuidv7()}`
		await db
			.insert(userSettings)
			.values({ organization_id: actor.organizationId, user_id: userId, projects_v2_enabled: true })
		await db
			.insert(onlineHosts)
			.values({ organization_id: actor.organizationId, user_id: userId, host_id: hostId, status: 'online' })
		await db.insert(repositoryLocationsForUserForHost).values({
			organization_id: actor.organizationId,
			user_id: userId,
			host_id: hostId,
			repository_identity: repository.repositoryIdentity,
			source_kind: 'managed_clone',
			source_path: null,
		})
		const context = createMockApiContext({
			auth: {
				userId,
				organizationId: actor.organizationId,
				workosOrganizationId: `workos-${actor.organizationId}`,
				role: '',
				roles: [],
				permissions: [],
				entitlements: [],
				sessionId: 'session',
			},
			services,
		})
		return { userId, hostId, context }
	}

	const firstSession = {
		title: null as string | null,
		text: 'implement the feature',
		hostId: '',
		codingAgent: 'claude' as const,
		provider: 'anthropic',
		model: 'opus',
		permissionsMode: 'default' as const,
	}

	async function deliveryFixture(
		mode: 'off' | 'pr-only' | 'merge' = 'merge',
		override?: 'inherit' | 'off' | 'pr-only' | 'merge',
		intent: 'research' | 'implementation' = 'implementation',
	) {
		const actor = await setupActor()
		await db.update(projects).set({ delivery_mode: mode }).where(eq(projects.id, actor.projectId))
		const input = {
			taskId: uuidv7(),
			workspaceId: uuidv7(),
			sessionId: uuidv7(),
			projectId: actor.projectId,
			name: 'Delivery task',
			slug: 'delivery-task',
			repositories: [repository],
			deliveryOverride: override,
			workflowType: 'freeform' as const,
			firstSession: { ...firstSession, hostId: actor.hostId, intent },
		}
		await call(createTaskV2, input, { context: actor.context })
		const state = async () => (await db.select().from(tasks).where(eq(tasks.id, input.taskId)))[0]!
		const enroll = () =>
			db.transaction(async (tx) =>
				enrollProjectDelivery(
					tx,
					(await lockDeliveryTask(tx, input.taskId, actor.organizationId))!,
					actor.hostId,
				),
			)
		const materialize = () =>
			db
				.update(workspaceRepositoryStatusForUserForHost)
				.set({
					status: 'done',
					repo_available: true,
					error: null,
					materialization: {
						kind: 'worktree',
						path: '/tmp/actual-materialized-delivery',
						branch: repository.branch,
					},
				})
				.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, input.workspaceId))
		return { actor, input, state, enroll, materialize }
	}

	test.each([
		['off', undefined, 'off'],
		['merge', undefined, 'merge'],
		['pr-only', 'inherit', 'pr-only'],
		['merge', 'off', 'off'],
		['merge', 'pr-only', 'pr-only'],
		['off', 'merge', 'merge'],
	] as const)('snapshots %s with override %s as %s', async (mode, override, expected) => {
		const f = await deliveryFixture(mode, override)
		expect((await f.state()).delivery_snapshot).toMatchObject({ mode: expected, authorizedBy: f.actor.userId })
		expect((await f.state()).automatic_delivery).toBeNull()
		await f.materialize()
		await f.enroll()
		expect((await f.state()).automatic_delivery?.mode ?? 'off').toBe(expected)
	})

	test('uses exact materialized targets and preserves snapshots and evidence on retries', async () => {
		const f = await deliveryFixture('pr-only')
		await f.enroll()
		expect((await f.state()).automatic_delivery).toBeNull()
		await f.materialize()
		await f.enroll()
		const enrolled = (await f.state()).automatic_delivery!
		expect(enrolled).toMatchObject({
			sourceSessionId: f.input.sessionId,
			hostId: f.actor.hostId,
			mode: 'pr-only',
			targets: [
				{
					repository: 'humanlayer/syncopate',
					base: 'main',
					branch: repository.branch,
					directory: '/tmp/actual-materialized-delivery',
				},
			],
		})
		await db
			.update(tasks)
			.set({ automatic_delivery: { ...enrolled, passes: 2, recoveryAttempts: 1 } })
			.where(eq(tasks.id, f.input.taskId))
		const before = await f.state()
		await db.update(projects).set({ delivery_mode: 'merge' }).where(eq(projects.id, f.actor.projectId))
		expect(
			(await call(createTaskV2, { ...f.input, deliveryOverride: 'merge' }, { context: f.actor.context })).result,
		).toBe('already-exists')
		await f.enroll()
		const after = await f.state()
		expect(after.delivery_snapshot).toEqual(before.delivery_snapshot)
		expect(after.automatic_delivery).toEqual(before.automatic_delivery)
	})

	test('the existing daemon claim enrolls the snapshot and owns the PR successor', async () => {
		const f = await deliveryFixture('pr-only')
		await f.materialize()
		await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, f.input.sessionId))
		const context = createMockDaemonContext({
			auth: createMockDaemonAuth({
				userId: f.actor.userId,
				organizationId: f.actor.organizationId,
				hostId: f.actor.hostId,
			}),
			services: { db, dbReadReplica: db },
		})
		expect((await call(claimDeliveryProcedure, {}, { context })).action).toBeNull()
		expect((await f.state()).automatic_delivery).toMatchObject({
			mode: 'pr-only',
			phase: 'implementation',
			sourceSessionId: f.input.sessionId,
		})
		await db.insert(sessionRepositories).values({
			organization_id: f.actor.organizationId,
			task_id: f.input.taskId,
			session_id: f.input.sessionId,
			host_id: f.actor.hostId,
			local_path: '/tmp/actual-materialized-delivery',
			repo_full_name: 'humanlayer/syncopate',
			branch: repository.branch,
		})
		await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.input.sessionId))
		await call(claimDeliveryProcedure, {}, { context })
		const state = await f.state()
		expect(state.automatic_delivery?.phase).toBe('pr')
		expect(state.automatic_delivery?.managedSessionId).toBeTruthy()
		expect(await db.select().from(sessions).where(eq(sessions.task_id, f.input.taskId))).toHaveLength(2)
	})

	test('does not enroll planning-only work and selects its later implementation session', async () => {
		const f = await deliveryFixture('merge', undefined, 'research')
		await f.materialize()
		await db.update(sessions).set({ status: 'ready_for_input' }).where(eq(sessions.id, f.input.sessionId))
		await f.enroll()
		expect((await f.state()).automatic_delivery).toBeNull()
		const [implementation] = await db
			.insert(sessions)
			.values({
				organization_id: f.actor.organizationId,
				task_id: f.input.taskId,
				created_by: f.actor.userId,
				resource_owner_user_id: f.actor.userId,
				host_id: f.actor.hostId,
				status: 'running',
				working_directory: '/tmp/actual-materialized-delivery',
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'opus',
				labels: [{ name: 'rpi:implementation', title: 'implementation' }],
			})
			.returning()
		await f.enroll()
		expect((await f.state()).automatic_delivery?.sourceSessionId).toBe(implementation!.id)
	})

	test('an explicit research intent is not overwritten by a oneshot workflow', async () => {
		const actor = await setupActor()
		const input = {
			taskId: uuidv7(),
			workspaceId: uuidv7(),
			sessionId: uuidv7(),
			projectId: actor.projectId,
			name: 'Research only',
			slug: 'research-only',
			repositories: [repository],
			workflowType: 'oneshot' as const,
			firstSession: { ...firstSession, hostId: actor.hostId, intent: 'research' as const },
		}
		await call(createTaskV2, input, { context: actor.context })
		const [session] = await db.select().from(sessions).where(eq(sessions.id, input.sessionId))
		expect(session!.labels).toEqual([{ name: 'rpi:research', title: 'research' }])
	})

	test.each(['wrong-branch', 'relative-path', 'unavailable', 'wrong-repository', 'wrong-remote'] as const)(
		'refuses a %s materialization',
		async (problem) => {
			const f = await deliveryFixture()
			await f.materialize()
			const changes =
				problem === 'wrong-branch'
					? {
							materialization: {
								kind: 'worktree' as const,
								path: '/tmp/actual-materialized-delivery',
								branch: 'main',
							},
						}
					: problem === 'relative-path'
						? {
								materialization: {
									kind: 'worktree' as const,
									path: '~/guessed-path',
									branch: repository.branch,
								},
							}
						: problem === 'unavailable'
							? { repo_available: false }
							: problem === 'wrong-repository'
								? { repository_identity: 'github.com/other/repo' }
								: { repository_remote_url: 'https://github.com/other/repo.git' }
			await db
				.update(workspaceRepositoryStatusForUserForHost)
				.set(changes)
				.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, f.input.workspaceId))
			await f.enroll()
			expect((await f.state()).automatic_delivery).toBeNull()
		},
	)

	test.each(['base-branch', 'non-github', 'too-many'] as const)(
		'rejects an unsupported %s delivery recipe before creating work',
		async (reason) => {
			const actor = await setupActor()
			const repos =
				reason === 'too-many'
					? Array.from({ length: 11 }, (_, index) => ({
							...repository,
							repositoryIdentity: `github.com/humanlayer/repo-${index}`,
							remoteUrl: `https://github.com/humanlayer/repo-${index}.git`,
							default: index === 0,
						}))
					: [
							{
								...repository,
								...(reason === 'base-branch'
									? { branch: 'main' }
									: {
											repositoryIdentity: 'gitlab.com/humanlayer/syncopate',
											remoteUrl: 'https://gitlab.com/humanlayer/syncopate.git',
										}),
							},
						]
			await db
				.update(projects)
				.set({ repositories: repos, delivery_mode: 'merge' })
				.where(eq(projects.id, actor.projectId))
			const taskId = uuidv7()
			await expect(
				call(
					createTaskV2,
					{
						taskId,
						workspaceId: uuidv7(),
						projectId: actor.projectId,
						name: 'Unsupported delivery',
						slug: 'unsupported-delivery',
						repositories: repos,
						firstSession: { ...firstSession, hostId: actor.hostId, intent: 'implementation' },
					},
					{ context: actor.context },
				),
			).rejects.toMatchObject({
				code: 'UNSUPPORTED_RECIPE',
				data: { message: expect.stringContaining('Choose Off') },
			})
			expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(0)
		},
	)

	test('shared project defaults cannot grant another user merge authority', async () => {
		const actor = await setupActor()
		await db.update(projects).set({ delivery_mode: 'merge' }).where(eq(projects.id, actor.projectId))
		const other = await setupCollaborator(actor)
		const input = {
			taskId: uuidv7(),
			workspaceId: uuidv7(),
			projectId: actor.projectId,
			name: 'Other owner',
			slug: 'other-owner',
			repositories: [repository],
			firstSession: { ...firstSession, hostId: other.hostId, intent: 'implementation' as const },
		}
		await call(createTaskV2, input, { context: other.context })
		const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId))
		expect(task!.delivery_snapshot).toMatchObject({ mode: 'off', authorizedBy: other.userId })
	})

	test('atomically creates workspace, task, session, and repository status rows', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		const workspaceId = uuidv7()
		const result = await call(
			createTaskV2,
			{
				taskId,
				workspaceId,
				projectId: actor.projectId,
				name: 'V2 task',
				slug: 'v2-task',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		expect(result.result).toBe('created')
		expect(result.taskId).toBe(taskId)
		expect(result.workspaceId).toBe(workspaceId)

		const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(task!.project_id).toBe(actor.projectId)
		expect(task!.workspace_id).toBe(workspaceId)
		expect(task!.slug).toBe('v2-task')
		expect(task!.default_working_directory).toBe('~/.humanlayer/workspaces/v2-task')
		expect(task!.workspace_spec).toBeNull()
		expect(task!.workspace_state).toBeNull()
		expect(task!.is_draft).toBe(false)

		const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		expect(workspace!.project_id).toBe(actor.projectId)

		const statusRows = await db
			.select()
			.from(workspaceRepositoryStatusForUserForHost)
			.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, workspaceId))
		expect(statusRows).toHaveLength(1)
		expect(statusRows[0]!.status).toBe('setup_requested')
		expect(statusRows[0]!.source_kind).toBe('filesystem')
		expect(statusRows[0]!.source_policy).toBe('filesystem_required')
		expect(statusRows[0]!.source_path).toBe('/home/user/projects/syncopate')

		const locationRows = await db
			.select()
			.from(workspaceLocationsForUserForHost)
			.where(eq(workspaceLocationsForUserForHost.workspace_id, workspaceId))
		expect(locationRows).toHaveLength(1)
		expect(locationRows[0]!.file_path).toBe('~/.humanlayer/workspaces/v2-task')

		const sessionRows = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		expect(sessionRows).toHaveLength(1)
		expect(sessionRows[0]!.status).toBe('ready_for_launch')
		expect(sessionRows[0]!.labels).toEqual([{ name: 'rpi:implementation', title: 'implementation' }])
		expect(sessionRows[0]!.working_directory).toBe('~/.humanlayer/workspaces/v2-task')

		const [launch] = await db.select().from(taskLaunches).where(eq(taskLaunches.task_id, taskId))
		expect(launch!.first_session_id).toBe(sessionRows[0]!.id)
		expect(scheduledTitleGenerations).toEqual([
			{
				sessionId: result.sessionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
				prompt: firstSession.text,
				ticketId: null,
				taskName: 'V2 task',
			},
		])
	})

	test.each(['', '   '])('generates a title when the first-session title is blank (%j)', async (title) => {
		const actor = await setupActor()
		const result = await call(
			createTaskV2,
			{
				taskId: uuidv7(),
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Untitled session task',
				slug: 'untitled-session-task',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId, title },
			},
			{ context: actor.context },
		)

		expect(scheduledTitleGenerations).toEqual([
			{
				sessionId: result.sessionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
				prompt: firstSession.text,
				ticketId: null,
				taskName: 'Untitled session task',
			},
		])
	})

	test.each([
		{ title: 'Keep this title', text: firstSession.text },
		{ title: null, text: '   ' },
	])('skips title generation with an explicit title or empty prompt (%j)', async ({ title, text }) => {
		const actor = await setupActor()
		const result = await call(
			createTaskV2,
			{
				taskId: uuidv7(),
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Preserved session task',
				slug: 'preserved-session-task',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId, title, text },
			},
			{ context: actor.context },
		)

		const [session] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId))
		expect(session?.title).toBe(title)
		expect(scheduledTitleGenerations).toEqual([])
	})

	test.each([
		['How does the launcher work?', [{ name: 'rpi:research', title: 'research' }]],
		["Let's make a plan for the launcher", [{ name: 'rpi:design', title: 'design' }]],
		['implement the launcher', [{ name: 'rpi:implementation', title: 'implementation' }]],
		['Unclear request', []],
	])('persists classification labels for a freeform prompt: %s', async (text, labels) => {
		const actor = await setupActor()
		const result = await call(
			createTaskV2,
			{
				taskId: uuidv7(),
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Classified task',
				slug: 'classified-task',
				repositories: [repository],
				firstSession: { ...firstSession, text, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		const [session] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId))
		expect(session?.labels).toEqual(labels)
	})

	test('queues the first session on an owned host that is offline', async () => {
		const actor = await setupActor()
		await db
			.update(onlineHosts)
			.set({ status: 'offline', last_seen: BigInt(Date.now() - 600_000) })
			.where(eq(onlineHosts.host_id, actor.hostId))
		const taskId = uuidv7()

		const result = await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Offline host task',
				slug: 'offline-host-task',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		expect(result.result).toBe('created')
		const sessionRows = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		expect(sessionRows).toEqual([expect.objectContaining({ status: 'ready_for_launch', host_id: actor.hostId })])
	})

	test('promotes an owned draft into a complete project-backed task', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		await db.insert(tasks).values({
			id: taskId,
			organization_id: actor.organizationId,
			name: 'Saved draft',
			slug: 'saved-draft',
			created_by: actor.userId,
			resource_owner_user_id: actor.userId,
			is_draft: true,
		})

		const result = await call(
			createTaskV2,
			{
				taskId,
				workspaceId: taskId,
				projectId: actor.projectId,
				name: 'Launched draft',
				slug: 'launched-draft',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		expect(result.result).toBe('created')
		const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(task).toMatchObject({
			id: taskId,
			project_id: actor.projectId,
			workspace_id: taskId,
			name: 'Launched draft',
			slug: 'launched-draft',
			default_working_directory: '~/.humanlayer/workspaces/launched-draft',
			is_draft: false,
		})

		const locationRows = await db
			.select()
			.from(workspaceLocationsForUserForHost)
			.where(eq(workspaceLocationsForUserForHost.workspace_id, taskId))
		expect(locationRows).toHaveLength(1)

		const statusRows = await db
			.select()
			.from(workspaceRepositoryStatusForUserForHost)
			.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, taskId))
		expect(statusRows).toHaveLength(1)
		expect(statusRows[0]!.status).toBe('setup_requested')

		const sessionRows = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		expect(sessionRows).toHaveLength(1)
		expect(sessionRows[0]).toMatchObject({
			status: 'ready_for_launch',
			working_directory: '~/.humanlayer/workspaces/launched-draft',
			labels: [{ name: 'rpi:implementation', title: 'implementation' }],
		})

		const [launch] = await db.select().from(taskLaunches).where(eq(taskLaunches.task_id, taskId))
		expect(launch!.first_session_id).toBe(sessionRows[0]!.id)
		expect(scheduledTitleGenerations).toEqual([
			{
				sessionId: result.sessionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
				prompt: firstSession.text,
				ticketId: null,
				taskName: 'Launched draft',
			},
		])
	})

	test('keeps the draft unchanged when project workspace creation fails', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		await db.insert(tasks).values({
			id: taskId,
			organization_id: actor.organizationId,
			name: 'Saved draft',
			slug: 'saved-draft',
			created_by: actor.userId,
			resource_owner_user_id: actor.userId,
			is_draft: true,
		})
		const [draftBeforeLaunch] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		await db
			.delete(repositoryLocationsForUserForHost)
			.where(eq(repositoryLocationsForUserForHost.organization_id, actor.organizationId))

		await expect(
			call(
				createTaskV2,
				{
					taskId,
					workspaceId: taskId,
					projectId: actor.projectId,
					name: 'Launched draft',
					slug: 'launched-draft',
					repositories: [repository],
					firstSession: { ...firstSession, hostId: actor.hostId },
				},
				{ context: actor.context },
			),
		).rejects.toMatchObject({ code: 'REPOSITORY_SOURCES_REQUIRED' })

		const [draftAfterLaunch] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(draftAfterLaunch).toEqual(draftBeforeLaunch)
		const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, taskId))
		expect(workspace).toBeUndefined()
		const sessionRows = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		expect(sessionRows).toHaveLength(0)
		expect(scheduledTitleGenerations).toEqual([])
	})

	test('returns already-exists on replay with the same stable IDs', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		const workspaceId = uuidv7()
		const input = {
			taskId,
			workspaceId,
			projectId: actor.projectId,
			name: 'Replay task',
			slug: 'replay-task',
			repositories: [repository],
			firstSession: { ...firstSession, hostId: actor.hostId },
		}

		const first = await call(createTaskV2, input, { context: actor.context })
		expect(first.result).toBe('created')

		const second = await call(
			createTaskV2,
			{ ...input, firstSession: { ...input.firstSession, text: 'How does the launcher work?' } },
			{ context: actor.context },
		)
		expect(second.result).toBe('already-exists')
		expect(second.taskId).toBe(taskId)
		const [session] = await db.select().from(sessions).where(eq(sessions.id, first.sessionId))
		expect(session?.labels).toEqual([{ name: 'rpi:implementation', title: 'implementation' }])
		expect(scheduledTitleGenerations).toHaveLength(1)
		expect(scheduledTitleGenerations[0]?.sessionId).toBe(first.sessionId)
	})

	test('does not create placement setup when a replay changes workspace inputs', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		const workspaceId = uuidv7()
		const input = {
			taskId,
			workspaceId,
			projectId: actor.projectId,
			name: 'Replay task',
			slug: 'replay-task',
			repositories: [repository],
			firstSession: { ...firstSession, hostId: actor.hostId },
		}

		const first = await call(createTaskV2, input, { context: actor.context })
		expect(first.result).toBe('created')

		const replayWorkspaceId = uuidv7()
		const replay = await call(
			createTaskV2,
			{ ...input, workspaceId: replayWorkspaceId, slug: 'different-replay-task' },
			{ context: actor.context },
		)
		expect(replay.result).toBe('already-exists')

		const replayLocations = await db
			.select()
			.from(workspaceLocationsForUserForHost)
			.where(eq(workspaceLocationsForUserForHost.workspace_id, replayWorkspaceId))
		const replayStatuses = await db
			.select()
			.from(workspaceRepositoryStatusForUserForHost)
			.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, replayWorkspaceId))
		expect(replayLocations).toHaveLength(0)
		expect(replayStatuses).toHaveLength(0)
	})

	test('requires repository sources and rolls back task placement creation', async () => {
		const actor = await setupActor()
		await db
			.delete(repositoryLocationsForUserForHost)
			.where(eq(repositoryLocationsForUserForHost.organization_id, actor.organizationId))
		const workspaceId = uuidv7()

		await expect(
			call(
				createTaskV2,
				{
					taskId: uuidv7(),
					workspaceId,
					projectId: actor.projectId,
					name: 'Managed task',
					slug: 'managed-task',
					repositories: [repository],
					firstSession: { ...firstSession, hostId: actor.hostId },
				},
				{ context: actor.context },
			),
		).rejects.toMatchObject({
			code: 'REPOSITORY_SOURCES_REQUIRED',
			data: {
				projectId: actor.projectId,
				workspaceId,
				hostId: actor.hostId,
				missingRepositoryIdentities: [repository.repositoryIdentity],
			},
		})

		const [status] = await db
			.select()
			.from(workspaceRepositoryStatusForUserForHost)
			.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, workspaceId))
		const [location] = await db
			.select()
			.from(workspaceLocationsForUserForHost)
			.where(eq(workspaceLocationsForUserForHost.workspace_id, workspaceId))
		expect(status).toBeUndefined()
		expect(location).toBeUndefined()
	})

	test('rejects mixed projects when any repository source is unknown', async () => {
		const actor = await setupActor()
		const secondRepository = {
			...repository,
			remoteUrl: 'https://github.com/humanlayer/agentlayer.git',
			repositoryIdentity: 'github.com/humanlayer/agentlayer',
			branch: 'workspace-test-agentlayer',
			default: false as const,
		}
		await db
			.update(projects)
			.set({ repositories: [{ ...repository, default: true }, secondRepository] })
			.where(eq(projects.id, actor.projectId))
		const workspaceId = uuidv7()

		await expect(
			call(
				createTaskV2,
				{
					taskId: uuidv7(),
					workspaceId,
					projectId: actor.projectId,
					name: 'Partial mapping task',
					slug: 'partial-mapping-task',
					repositories: [repository, secondRepository],
					firstSession: { ...firstSession, hostId: actor.hostId },
				},
				{ context: actor.context },
			),
		).rejects.toMatchObject({
			code: 'REPOSITORY_SOURCES_REQUIRED',
			data: { missingRepositoryIdentities: [secondRepository.repositoryIdentity] },
		})

		const statuses = await db
			.select()
			.from(workspaceRepositoryStatusForUserForHost)
			.where(eq(workspaceRepositoryStatusForUserForHost.workspace_id, workspaceId))
		expect(statuses).toEqual([])
	})

	test('rejects when projects v2 is disabled', async () => {
		const actor = await setupActor(false)
		await expect(
			call(
				createTaskV2,
				{
					taskId: uuidv7(),
					workspaceId: uuidv7(),
					projectId: actor.projectId,
					name: 'Should fail',
					slug: 'should-fail',
					repositories: [repository],
					firstSession: { ...firstSession, hostId: actor.hostId },
				},
				{ context: actor.context },
			),
		).rejects.toThrow(ORPCError)
	})

	test('accepts branch publishing, copy globs, and setup commands from the project recipe', async () => {
		const configuredRepository = {
			...repository,
			autoPushBranch: true,
			copyGlobs: ['.env'],
			setupCommand: 'bun install',
		}
		const actor = await setupActor(true, configuredRepository)
		const result = await call(
			createTaskV2,
			{
				taskId: uuidv7(),
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Complete setup recipe task',
				slug: 'complete-setup-recipe-task',
				repositories: [configuredRepository],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)
		expect(result.result).toBe('created')
	})

	test('rejects when project does not exist', async () => {
		const actor = await setupActor()
		await expect(
			call(
				createTaskV2,
				{
					taskId: uuidv7(),
					workspaceId: uuidv7(),
					projectId: uuidv7(),
					name: 'Missing project',
					slug: 'missing-project',
					repositories: [repository],
					firstSession: { ...firstSession, hostId: actor.hostId },
				},
				{ context: actor.context },
			),
		).rejects.toThrow(ORPCError)
	})

	test('prevents non-owners from creating tasks from private projects', async () => {
		const owner = await setupActor()
		await db.update(projects).set({ private: true }).where(eq(projects.id, owner.projectId))
		const collaborator = await setupCollaborator(owner)

		await expect(
			call(
				createTaskV2,
				{
					taskId: uuidv7(),
					workspaceId: uuidv7(),
					projectId: owner.projectId,
					name: 'Private project task',
					slug: 'private-project-task',
					repositories: [repository],
					firstSession: { ...firstSession, hostId: collaborator.hostId },
				},
				{ context: collaborator.context },
			),
		).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
	})

	test('lets organization members create tasks from shared projects', async () => {
		const owner = await setupActor()
		const collaborator = await setupCollaborator(owner)
		const taskId = uuidv7()
		const workspaceId = uuidv7()

		const result = await call(
			createTaskV2,
			{
				taskId,
				workspaceId,
				projectId: owner.projectId,
				name: 'Shared project task',
				slug: 'shared-project-task',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: collaborator.hostId },
			},
			{ context: collaborator.context },
		)

		expect(result.result).toBe('created')
		const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		expect(task).toMatchObject({
			project_id: owner.projectId,
			workspace_id: workspaceId,
			resource_owner_user_id: collaborator.userId,
		})
		expect(workspace).toMatchObject({
			project_id: owner.projectId,
			resource_owner_user_id: collaborator.userId,
		})
	})

	test('persists workflow, ticket, task content, and attachment metadata', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Metadata task',
				slug: 'metadata-task',
				repositories: [repository],
				taskContent: 'Do the thing\n\n@.humanlayer/tasks/metadata-task/spec.md',
				ticketDescription: 'Do the thing',
				ticketProvider: 'linear',
				ticketId: 'ENG-1',
				workflowType: 'prd_tdd',
				autoAdvanceQuestionsToResearch: true,
				attachments: [
					{
						fileName: 'spec.md',
						contentType: 'text/markdown',
						fileSizeBytes: 12,
						contentHash: 'a'.repeat(64),
					},
				],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(task!.slug).toBe('metadata-task')
		expect(task!.workflow_type).toBe('prd_tdd')
		expect(task!.worktree_timing).toBe('now')
		expect(task!.ticket_provider).toBe('linear')
		expect(task!.ticket_id).toBe('ENG-1')
		expect(task!.ticket_description).toBe('Do the thing')
		expect(task!.auto_advance_questions_to_research).toBe(true)
		expect(task!.auto_advance_research_to_design).toBe(false)
		const [session] = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		expect(session?.labels).toEqual([])

		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))
		const byName = new Map(artifactRows.map((row) => [row.file_name, row]))
		expect(byName.get('task.md')?.content).toContain('Do the thing')
		expect(byName.get('task.md')?.content).toContain('See [ENG-1](./ENG-1.md).')
		expect(byName.get('ENG-1.md')?.content).toContain('Description for ENG-1')
		expect(byName.get('ENG-1.md')?.storage_type).toBe('postgres')
		expect(byName.get('spec.md')?.storage_type).toBe('s3')
		expect(byName.get('spec.md')?.s3_key).toBe(`${actor.organizationId}/${taskId}/spec.md`)
	})

	test('prefers the launcher intent over classification, and leaves an unclassifiable prompt unlabeled', async () => {
		const actor = await setupActor()
		const labeledId = uuidv7()
		const unlabeledId = uuidv7()
		for (const [taskId, intent, text] of [
			[labeledId, 'implementation', 'How does the launcher work?'],
			[unlabeledId, undefined, 'Unclear request'],
		] as const) {
			await call(
				createTaskV2,
				{
					taskId,
					workspaceId: uuidv7(),
					projectId: actor.projectId,
					name: `Intent task ${taskId.slice(-4)}`,
					slug: `intent-task-${taskId.slice(-4)}`,
					repositories: [repository],
					firstSession: { ...firstSession, hostId: actor.hostId, intent, text },
				},
				{ context: actor.context },
			)
		}

		const [labeled] = await db.select().from(sessions).where(eq(sessions.task_id, labeledId))
		const [unlabeled] = await db.select().from(sessions).where(eq(sessions.task_id, unlabeledId))
		expect(labeled!.labels).toEqual([{ name: 'rpi:implementation', title: 'implementation' }])
		expect(unlabeled!.labels).toEqual([])
	})

	test('creates ticket artifact with images for Linear tickets', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		const linearWithImages = createMockLinearService({
			getIssue: async (_orgId: string, ticketId: string) => ({
				identifier: ticketId,
				title: 'Bug with screenshot',
				url: `https://linear.app/test/issue/${ticketId}`,
				branch: null,
				status: 'In Progress',
				assignee: null,
				description: `Here is the bug:\n\n![screenshot](https://uploads.linear.app/abc/image1.png)`,
				comments: [],
				parents: [],
			}),
			getAccessToken: async () => 'mock-token',
		})
		const ctx = createMockApiContext({
			auth: {
				userId: actor.userId,
				organizationId: actor.organizationId,
				workosOrganizationId: `workos-${actor.organizationId}`,
			},
			services: {
				...services,
				linear: linearWithImages,
			},
		})

		await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Image ticket task',
				slug: 'image-ticket-task',
				repositories: [repository],
				taskContent: 'Fix the bug shown in the ticket',
				ticketProvider: 'linear',
				ticketId: 'BUG-42',
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: ctx },
		)

		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))
		const byName = new Map(artifactRows.map((row) => [row.file_name, row]))
		expect(byName.get('task.md')?.content).toContain('See [BUG-42](./BUG-42.md).')
		expect(byName.get('BUG-42.md')).toBeDefined()
		expect(byName.get('BUG-42.md')?.storage_type).toBe('postgres')
		expect(byName.get('BUG-42.md')?.content).toContain('Bug with screenshot')
	})

	test('creates ticket artifact for Jira tickets', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		const jiraService = createMockJiraService({
			getIssue: async () => ({
				key: 'PROJ-99',
				summary: 'Jira bug report',
				url: 'https://jira.example.com/browse/PROJ-99',
				status: 'Open',
				description: 'Steps to reproduce the Jira issue',
			}),
		})
		const ctx = createMockApiContext({
			auth: {
				userId: actor.userId,
				organizationId: actor.organizationId,
				workosOrganizationId: `workos-${actor.organizationId}`,
			},
			services: { ...services, jira: jiraService },
		})

		await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'Jira task',
				slug: 'jira-task',
				repositories: [repository],
				taskContent: 'Fix the Jira issue',
				ticketProvider: 'jira',
				ticketId: 'PROJ-99',
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: ctx },
		)

		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))
		const byName = new Map(artifactRows.map((row) => [row.file_name, row]))
		expect(byName.get('task.md')?.content).toContain('See [PROJ-99](./PROJ-99.md).')
		expect(byName.get('PROJ-99.md')?.storage_type).toBe('postgres')
		expect(byName.get('PROJ-99.md')?.content).toContain('Jira bug report')
		expect(byName.get('PROJ-99.md')?.content).toContain('Steps to reproduce the Jira issue')
	})

	test('creates task without ticket artifact when no provider is set', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'No ticket task',
				slug: 'no-ticket-task',
				repositories: [repository],
				taskContent: 'Just do the thing',
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))
		const byName = new Map(artifactRows.map((row) => [row.file_name, row]))
		expect(byName.get('task.md')?.content).toBe('Just do the thing')
		expect(artifactRows).toHaveLength(1)
	})

	test('V2 task leaves legacy workspace columns null', async () => {
		const actor = await setupActor()
		const taskId = uuidv7()
		await call(
			createTaskV2,
			{
				taskId,
				workspaceId: uuidv7(),
				projectId: actor.projectId,
				name: 'No legacy setup',
				slug: 'no-legacy-setup',
				repositories: [repository],
				firstSession: { ...firstSession, hostId: actor.hostId },
			},
			{ context: actor.context },
		)

		const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(task!.workspace_spec).toBeNull()
		expect(task!.workspace_state).toBeNull()
	})
})

import { expect, test, vi } from 'vitest'

import { readBoard } from '../src/commands/board'

const v2 = { onlineHosts: vi.fn() }

test('reads the full project board and exports active session status and timestamps', async () => {
	const projectId = 'test-project'
	const savedDrafts = Array.from({ length: 250 }, (_, index) => ({
		id: String(index).padStart(3, '0'),
		name: 'Project draft',
		project_id: projectId,
		is_draft: true,
	}))
	const implementation = { id: '250', name: 'Implementation', project_id: projectId, is_draft: false }
	const composerDraft = { id: '251', name: 'Composer draft', project_id: null, is_draft: true }
	const tasks = vi
		.fn()
		.mockResolvedValueOnce({ rows: savedDrafts })
		.mockResolvedValueOnce({ rows: [implementation, composerDraft] })
	const sessions = vi
		.fn()
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({
			rows: [
				{
					id: 'session',
					task_id: implementation.id,
					archived: false,
					labels: null,
					status: 'running',
					last_activity_at: '1754078400000',
				},
			],
		})

	const board = await readBoard({ tasks, sessions, v2 }, 'http://127.0.0.1:3000', projectId)

	expect(tasks).toHaveBeenCalledTimes(2)
	expect(tasks).toHaveBeenLastCalledWith(
		expect.objectContaining({
			where: {
				type: 'and',
				conditions: [
					{ type: 'comparison', field: ['archived'], operator: 'eq', value: false },
					{ type: 'comparison', field: ['project_id'], operator: 'eq', value: projectId },
					{ type: 'comparison', field: ['id'], operator: 'gt', value: '249' },
				],
			},
		}),
	)
	expect(sessions).toHaveBeenCalledTimes(3)
	expect(board.columns.find((column) => column.id === 'todo')?.cards).toHaveLength(250)
	expect(board.columns.find((column) => column.id === 'implementation')?.cards).toMatchObject([
		{
			id: implementation.id,
			projectId,
			status: 'running',
			lastUpdatedAt: new Date(1754078400000).toISOString(),
			url: 'http://127.0.0.1:3000/tasks/250',
		},
	])
})

test.each([
	['ready_for_launch', 'queued'],
	['running', 'running'],
	['failed', 'blocked'],
])('shows a stock Describe PR session with %s status as %s on the same card', async (status, expected) => {
	const tasks = vi.fn().mockResolvedValue({
		rows: [{ id: 'task', name: 'Publish', project_id: null, is_draft: false }],
	})
	const sessions = vi.fn().mockResolvedValue({
		rows: [
			{
				id: 'describe-pr',
				task_id: 'task',
				archived: false,
				labels: [{ name: 'rpi:describe-pr', title: 'describe-pr' }],
				status,
				last_activity_at: '1754078400000',
			},
		],
	})

	const board = await readBoard({ tasks, sessions, v2 }, 'http://127.0.0.1:3000')
	expect(board.columns.find((column) => column.id === 'implementation')?.cards).toMatchObject([
		{ id: 'task', delivery: { status: expected } },
	])
})

test.each([
	['standing', { slack: 'unavailable', origin: 'delivered', slackRoute: 'standing' }],
	['specific', { slack: 'unavailable', origin: 'delivered', slackRoute: 'specific' }],
	['off', { slack: 'unavailable', origin: 'delivered', slackRoute: 'off' }],
	['unavailable', { slack: 'unavailable', origin: 'delivered', slackRoute: 'unavailable' }],
	[undefined, { slack: 'unavailable', origin: 'delivered' }],
])('exports the effective Slack route %s on the blocked card', async (slackRoute, expectedAlert) => {
	const tasks = vi.fn().mockResolvedValue({
		rows: [
			{
				id: 'task',
				name: 'Publish',
				project_id: null,
				is_draft: false,
				implementation_reconciliation: {
					version: 1,
					decision: { status: 'blocked', reason: 'pr-not-ready', stage: 'implementation' },
					blockerAlert: {
						id: '22222222-2222-4222-8222-222222222222',
						slack: { status: 'unavailable' },
						origin: { status: 'delivered', receipt: 'native-receipt' },
						slackRoute,
					},
				},
			},
		],
	})
	const sessions = vi.fn().mockResolvedValue({ rows: [] })
	const board = await readBoard({ tasks, sessions, v2 }, 'http://127.0.0.1:3000')
	const delivery = board.columns.find((column) => column.id === 'implementation')?.cards[0]?.delivery
	expect(delivery?.status === 'blocked' && delivery.alert).toEqual(expectedAlert)
})

test('filters to attention without reassigning an external wait to another column', async () => {
	const tasks = vi.fn().mockResolvedValue({
		rows: [
			{ id: 'normal', name: 'Normal draft', project_id: 'project' },
			{
				id: 'waiting',
				name: 'Carrier review',
				organization_id: 'org',
				resource_owner_user_id: 'owner',
				project_id: 'project',
				task_attention: {
					id: '019abcde-1234-7abc-8abc-123456789abc',
					kind: 'external_wait',
					authorizedBy: 'owner',
					revision: 1,
					reason: 'Carrier review pending',
					responsible: 'SignalWire',
					nextAction: 'Confirm the counting period',
					openedAt: 1,
					updatedAt: 2,
					followUpAt: 100,
				},
			},
		],
	})
	const sessions = vi.fn().mockResolvedValue({
		rows: [
			{
				id: 'session',
				task_id: 'waiting',
				host_id: 'assigned',
				resource_owner_user_id: 'owner',
				archived: false,
				last_activity_at: 10,
				status: 'ready_for_input',
				labels: [{ name: 'rpi:implementation', title: 'Implementation' }],
			},
		],
	})
	v2.onlineHosts.mockResolvedValue({
		rows: [{ organization_id: 'org', user_id: 'owner', host_id: 'assigned', status: 'offline', last_seen: '60' }],
	})
	const result = await readBoard({ tasks, sessions, v2 }, 'http://127.0.0.1:3000', 'project', true)
	expect(v2.onlineHosts).toHaveBeenCalledWith({
		where: {
			type: 'and',
			conditions: [
				{ type: 'comparison', field: ['host_id'], operator: 'eq', value: 'assigned' },
				{ type: 'comparison', field: ['organization_id'], operator: 'eq', value: 'org' },
				{ type: 'comparison', field: ['user_id'], operator: 'eq', value: 'owner' },
			],
		},
		sorts: [],
		limit: 1,
	})
	expect(result.attentionCount).toBe(1)
	expect(result.columns.flatMap((column) => column.cards)).toMatchObject([
		{
			id: 'waiting',
			columnId: 'implementation',
			status: 'ready_for_input',
			attention: [
				{
					kind: 'external_wait',
					responsible: 'SignalWire',
					followUpAt: 100,
					followUpHost: { id: 'assigned', status: 'offline', lastHeartbeatAt: 60 },
				},
			],
		},
	])
	v2.onlineHosts.mockRejectedValueOnce(new Error('Host status temporarily unavailable'))
	const impaired = await readBoard({ tasks, sessions, v2 }, 'http://127.0.0.1:3000', 'project', true)
	expect(impaired.columns.flatMap((column) => column.cards)[0]?.attention[0]?.followUpHost).toEqual({
		id: 'assigned',
		status: 'unknown',
	})
})

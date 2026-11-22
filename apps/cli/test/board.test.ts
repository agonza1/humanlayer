import { expect, test, vi } from 'vitest'

import { readBoard } from '../src/commands/board'

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

	const board = await readBoard({ tasks, sessions }, 'http://127.0.0.1:3000', projectId)

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

	const board = await readBoard({ tasks, sessions }, 'http://127.0.0.1:3000')
	expect(board.columns.find((column) => column.id === 'implementation')?.cards).toMatchObject([
		{ id: 'task', delivery: { status: expected } },
	])
})

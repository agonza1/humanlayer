import { Command } from 'commander'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerApiCommand } from '../src/api'

const set = vi.hoisted(() => vi.fn())
vi.mock('../src/api/lazy-client', () => ({
	createLazyClient: () => async () => ({ tasks: { attention: { set } } }),
}))

const taskId = '01954f4e-3c40-7b97-8832-52b06284ffbb'
const cursor = { id: '01954f4e-3c40-7b97-8832-52b06284ffbc', revision: 1 }
const attention = {
	kind: 'external_wait',
	reason: 'Provider route confirmation is pending',
	responsible: 'Provider support',
	nextAction: 'Confirm the supported routes before scheduling a pilot',
}

function runSet(...expectedArgs: string[]) {
	const program = new Command()
	registerApiCommand(program, () => 'dev')
	return program.parseAsync(
		[
			'api',
			'tasks',
			'attention',
			'set',
			'--task-id',
			taskId,
			'--attention',
			JSON.stringify(attention),
			...expectedArgs,
		],
		{ from: 'user' },
	)
}

beforeEach(() => {
	set.mockReset()
	set.mockResolvedValue({ attention: null })
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

it('opens an attention occurrence without the expected cursor option', async () => {
	await runSet()
	expect(set).toHaveBeenCalledExactlyOnceWith({ taskId, attention, expected: null })
})

it('forwards the exact attention ID and revision when editing', async () => {
	await runSet('--expected', JSON.stringify(cursor))
	expect(set).toHaveBeenCalledExactlyOnceWith({ taskId, attention, expected: cursor })
})

it('rejects an edit cursor without a revision before calling the API', async () => {
	await expect(runSet('--expected', JSON.stringify({ id: cursor.id }))).rejects.toThrow(/revision/)
	expect(set).not.toHaveBeenCalled()
})

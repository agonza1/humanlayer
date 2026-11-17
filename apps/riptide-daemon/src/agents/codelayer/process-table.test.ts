import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runOwnedCommand } from './owned-process'
import { coalesceSamples, DARWIN_PROCESS_TABLE, processTable } from './process-table'

const { execute, spawn } = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn() }))
vi.mock('node:util', async (original) => ({
	...(await original<typeof import('node:util')>()),
	promisify: () => execute,
}))
vi.mock('node:child_process', async (original) => ({
	...(await original<typeof import('node:child_process')>()),
	spawn,
}))

beforeEach(() => vi.resetAllMocks())

describe('process inspection', () => {
	it('uses isolated system Python and libproc on Darwin, returning metadata only', async () => {
		const rows = [{ pid: process.pid, parent: 1, state: '', started: '10:20' }]
		execute.mockResolvedValue({ stdout: JSON.stringify(rows) })
		expect(await processTable('darwin')).toEqual(rows)
		expect(execute).toHaveBeenCalledWith(
			'/usr/bin/python3',
			['-I', '-c', DARWIN_PROCESS_TABLE, String(process.pid)],
			expect.objectContaining({ timeout: 2_000 }),
		)
	})
	it('keeps the Linux ps inspector', async () => {
		execute.mockResolvedValue({ stdout: `${process.pid} 1 S Mon Nov 16 12:00:00 2026\n` })
		expect(await processTable('linux')).toEqual([
			{ pid: process.pid, parent: 1, state: 'S', started: 'Mon Nov 16 12:00:00 2026' },
		])
		expect(execute).toHaveBeenCalledWith('ps', expect.any(Array), { timeout: 2_000 })
	})
	it('rejects a table that cannot inspect the supervisor', async () => {
		execute.mockResolvedValue({ stdout: '[]' })
		await expect(processTable('darwin')).rejects.toThrow('Supervisor metadata unavailable')
	})
	it('does not launch commands when inspection permission is denied', async () => {
		execute.mockRejectedValue(new Error('proc_pidinfo: operation not permitted'))
		await expect(runOwnedCommand('never run', { cwd: '/', timeout: 100 })).rejects.toThrow(
			'operation not permitted',
		)
		expect(spawn).not.toHaveBeenCalled()
	})
	it('coalesces slow samples instead of queuing polling work, and recovers after failure', async () => {
		let reject!: (error: Error) => void
		const inspect = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((_, fail) => {
						reject = fail
					}),
			)
			.mockResolvedValueOnce([])
		const sample = coalesceSamples(inspect)
		const first = sample()
		for (let i = 0; i < 100; i++) expect(sample()).toBe(first)
		expect(inspect).toHaveBeenCalledTimes(1)
		reject(new Error('denied'))
		await expect(first).rejects.toThrow('denied')
		await expect(sample()).resolves.toEqual([])
		expect(inspect).toHaveBeenCalledTimes(2)
	})
})

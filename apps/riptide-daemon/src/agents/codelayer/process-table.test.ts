import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runOwnedCommand } from './owned-process'
import { coalesceSamples, DARWIN_PROCESS_TABLE, processTable } from './process-table'

const { execute, spawn, exists } = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn(), exists: vi.fn() }))
vi.mock('node:fs', async (original) => ({
	...(await original<typeof import('node:fs')>()),
	existsSync: exists,
}))
vi.mock('node:util', async (original) => ({
	...(await original<typeof import('node:util')>()),
	promisify: () => execute,
}))
vi.mock('node:child_process', async (original) => ({
	...(await original<typeof import('node:child_process')>()),
	spawn,
}))

beforeEach(() => {
	vi.resetAllMocks()
	exists.mockReturnValue(false)
})
afterEach(() => vi.unstubAllEnvs())

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
	it('uses the installed interpreter directly instead of the Apple xcrun launcher', async () => {
		exists.mockImplementation((path) => path === '/Library/Developer/CommandLineTools/usr/bin/python3')
		execute.mockResolvedValue({
			stdout: JSON.stringify([{ pid: process.pid, parent: 1, state: '', started: '10:20' }]),
		})
		await processTable('darwin')
		expect(execute.mock.calls[0]?.[0]).toBe('/Library/Developer/CommandLineTools/usr/bin/python3')
	})
	it('supports an explicit non-shim interpreter for other installations', async () => {
		vi.stubEnv('HUMANLAYER_PROCESS_INSPECTOR_PYTHON', '/configured/python3')
		execute.mockResolvedValue({
			stdout: JSON.stringify([{ pid: process.pid, parent: 1, state: '', started: '10:20' }]),
		})
		await processTable('darwin')
		expect(execute.mock.calls[0]?.[0]).toBe('/configured/python3')
		expect(exists).not.toHaveBeenCalled()
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
	it('retries one confirmed inspector timeout with a bounded longer deadline', async () => {
		execute
			.mockRejectedValueOnce(
				Object.assign(new Error('deadline'), { code: null, killed: true, signal: 'SIGTERM' }),
			)
			.mockResolvedValueOnce({ stdout: JSON.stringify([{ pid: process.pid }]) })
		await expect(processTable('darwin')).resolves.toEqual([{ pid: process.pid }])
		expect(execute).toHaveBeenCalledTimes(2)
		expect(execute.mock.calls.map((call) => call[2].timeout)).toEqual([2_000, 5_000])
	})
	it('stops after the second timeout and preserves subprocess diagnostics', async () => {
		execute.mockRejectedValue(
			Object.assign(new Error('deadline'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' }),
		)
		await expect(processTable('darwin')).rejects.toThrow('"signal":"SIGTERM","killed":true')
		expect(execute).toHaveBeenCalledTimes(2)
	})
	it('does not retry permission failures', async () => {
		execute.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
		await expect(processTable('darwin')).rejects.toThrow('"code":"EACCES"')
		expect(execute).toHaveBeenCalledTimes(1)
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

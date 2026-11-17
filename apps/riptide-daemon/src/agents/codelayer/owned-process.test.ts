import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { runOwnedCommand } from './owned-process'
import { processTable } from './process-table'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function running(pid: number) {
	const entry = (await processTable()).find((entry) => entry.pid === pid)
	return !!entry && !entry.state.startsWith('Z')
}

describe('owned Bash process cleanup', () => {
	it.each(['timeout', 'abort'] as const)(
		'cleans nested new process groups and SIGTERM-resistant children on %s, leaving a sentinel alive',
		async (reason) => {
			const directory = await mkdtemp(join(tmpdir(), 'owned-process-'))
			const journal = join(directory, 'pids')
			const record = `require('fs').appendFileSync(${JSON.stringify(journal)}, process.pid + '\\n');`
			const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
			const sentinelExit = new Promise((resolve) => sentinel.once('exit', resolve))
			const leaf = `${record} process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000)`
			const middle = `${record} require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {detached:true, stdio:'inherit'}); console.log(process.pid); setInterval(() => {}, 1000)`
			const root = `${record} require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], {detached:true, stdio:'inherit'}); console.log(process.pid); setInterval(() => {}, 1000)`
			const controller = new AbortController()
			const abort = reason === 'abort' ? setTimeout(() => controller.abort(), 900) : undefined
			let pids: number[] = []
			try {
				const result = await runOwnedCommand(`${quote(process.execPath)} -e ${quote(root)}`, {
					cwd: tmpdir(),
					timeout: reason === 'timeout' ? 900 : 5_000,
					signal: controller.signal,
				})
				pids = result.stdout.trim().split('\n').map(Number)
				expect(pids).toHaveLength(3)
				expect(result.exitCode).not.toBe(0)
				expect(result.timedOut).toBe(reason === 'timeout')
				expect(result.aborted).toBe(reason === 'abort')
				for (let attempt = 0; attempt < 30 && (await Promise.all(pids.map(running))).some(Boolean); attempt++)
					await delay(20)
				expect(await Promise.all(pids.map(running))).toEqual([false, false, false])
				expect(await running(sentinel.pid ?? -1)).toBe(true)
			} finally {
				clearTimeout(abort)
				// The journal is task-owned and survives executor errors, unlike captured stdout.
				pids = (await readFile(journal, 'utf8').catch(() => ''))
					.trim()
					.split('\n')
					.map(Number)
					.filter((pid) => Number.isInteger(pid) && pid > 1)
				for (const pid of pids) {
					if (await running(pid)) {
						try {
							process.kill(pid, 'SIGKILL')
						} catch {}
					}
				}
				sentinel.kill('SIGKILL')
				await sentinelExit
				await rm(directory, { recursive: true, force: true })
			}
		},
	)

	it('returns normal output and preserves nonzero failures', async () => {
		const result = await runOwnedCommand('echo output; echo error >&2; exit 4', { cwd: tmpdir(), timeout: 2_000 })
		expect(result).toMatchObject({
			stdout: 'output\n',
			stderr: 'error\n',
			exitCode: 4,
			timedOut: false,
			aborted: false,
		})
	})

	it('does not spawn a command for a pre-cancelled call', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			runOwnedCommand('sleep 10', { cwd: tmpdir(), timeout: 2_000, signal: controller.signal }),
		).rejects.toThrow()
	})
	it('merges session environment over inherited environment in the actual child without changing the parent', async () => {
		const previous = process.env.HUMANLAYER_BASH_INTEGRATION_FIXTURE
		process.env.HUMANLAYER_BASH_INTEGRATION_FIXTURE = 'inherited'
		try {
			const inherited = await runOwnedCommand('printf "%s|%s" "$HUMANLAYER_BASH_INTEGRATION_FIXTURE" "$PWD"', {
				cwd: tmpdir(),
				timeout: 2_000,
			})
			expect(inherited.stdout).toBe(`inherited|${await realpath(tmpdir())}`)
			const overridden = await runOwnedCommand('printf "%s|%s" "$HUMANLAYER_BASH_INTEGRATION_FIXTURE" "$PATH"', {
				cwd: tmpdir(),
				timeout: 2_000,
				env: { HUMANLAYER_BASH_INTEGRATION_FIXTURE: 'session' },
			})
			expect(overridden.stdout).toBe(`session|${process.env.PATH}`)
			expect(process.env.HUMANLAYER_BASH_INTEGRATION_FIXTURE).toBe('inherited')
		} finally {
			if (previous === undefined) delete process.env.HUMANLAYER_BASH_INTEGRATION_FIXTURE
			else process.env.HUMANLAYER_BASH_INTEGRATION_FIXTURE = previous
		}
	})
})

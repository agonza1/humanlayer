import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runOwnedCommand } from './owned-process'
import { executeVerification, serialVerification, verificationHandoff } from './verification'

// Exercise the persisted evidence and real Git boundary separately from OS tree cleanup.
vi.mock('./owned-process', () => ({ runOwnedCommand: vi.fn() }))
const exec = promisify(execFile)
let cwd: string
async function git(...args: string[]) {
	return exec('git', args, { cwd })
}
const command = `${JSON.stringify(process.execPath)} -e 'require("fs").appendFileSync(".git/runs", "x"); console.log("passed")'`
function check(overrides: Partial<Parameters<typeof executeVerification>[0]> = {}) {
	return executeVerification({
		command,
		scope: 'focused tests',
		finding: '',
		cwd,
		timeout: 2_000,
		signal: new AbortController().signal,
		env: {},
		task: 'task',
		session: 'implementation',
		allowReuse: false,
		...overrides,
	})
}

beforeEach(async () => {
	vi.mocked(runOwnedCommand).mockImplementation(async (command, options) => {
		try {
			const result = await exec('bash', ['-c', command], { cwd: options.cwd })
			return { ...result, exitCode: 0, timedOut: false, aborted: false }
		} catch (error) {
			const failure = error as { stdout: string; stderr: string; code: number }
			return {
				stdout: failure.stdout,
				stderr: failure.stderr,
				exitCode: failure.code,
				timedOut: false,
				aborted: false,
			}
		}
	})
	cwd = await mkdtemp(join(tmpdir(), 'verification-'))
	await git('init')
	await writeFile(join(cwd, 'input'), 'original')
	await git('add', 'input')
	await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture')
})
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

describe('implementation to PR evidence', () => {
	it('reuses successful clean exact-SHA evidence across sessions without executing again', async () => {
		expect(await check()).toContain('"passed":true')
		const result = await check({ allowReuse: true, session: 'describe-pr' })
		expect(result).toContain('Reused successful verification evidence')
		expect(result).toContain((await git('rev-parse', 'HEAD')).stdout.trim())
		expect(result).toContain('focused tests')
		expect(await readFile(join(cwd, '.git/runs'), 'utf8')).toBe('x')
		expect(await verificationHandoff(cwd, 'task')).toContain('"passed":true')
		expect(await verificationHandoff(cwd, 'another-task')).toContain('unavailable')
	})
	it('reuses exact-SHA evidence through a symlink alias of the same physical directory', async () => {
		const aliasRoot = await mkdtemp(join(tmpdir(), 'verification-alias-'))
		const alias = join(aliasRoot, 'checkout')
		try {
			await symlink(cwd, alias, 'dir')
			expect(await realpath(alias)).toBe(await realpath(cwd))
			expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toBe('')
			expect(await check()).toContain('"passed":true')
			const executions = vi.mocked(runOwnedCommand).mock.calls.length
			const result = await check({ cwd: alias, allowReuse: true, session: 'describe-pr' })
			expect(result).toContain('Reused successful verification evidence')
			expect(result).toContain((await git('rev-parse', 'HEAD')).stdout.trim())
			expect(result).toContain('"passed":true')
			expect(vi.mocked(runOwnedCommand).mock.calls.length).toBe(executions)
			expect(await readFile(join(cwd, '.git/runs'), 'utf8')).toBe('x')
			expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toBe('')
		} finally {
			await rm(aliasRoot, { recursive: true, force: true })
		}
	})
	it('does not reuse successful evidence from another directory in the same clean checkout', async () => {
		const nested = join(cwd, 'nested')
		await mkdir(nested)
		const directoryCommand = `${JSON.stringify(process.execPath)} -e 'console.log("passed")'`
		const executor = vi.mocked(runOwnedCommand)
		executor.mockClear()
		const revision = (await git('rev-parse', 'HEAD')).stdout.trim()
		expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toBe('')

		expect(await check({ command: directoryCommand })).toContain('"passed":true')
		expect(executor).toHaveBeenCalledTimes(1)
		expect(await check({ command: directoryCommand, allowReuse: true })).toContain(
			'Reused successful verification evidence',
		)
		expect(executor).toHaveBeenCalledTimes(1)

		const result = await check({ command: directoryCommand, cwd: nested, allowReuse: true })
		expect(result).not.toContain('Reused')
		expect(result).toContain('"passed":true')
		expect(result).toContain(revision)
		expect(executor).toHaveBeenCalledTimes(2)
		expect(executor).toHaveBeenNthCalledWith(
			2,
			directoryCommand,
			expect.objectContaining({ cwd: await realpath(nested) }),
		)
		expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(revision)
		expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toBe('')
	})
	it('does not reuse successful evidence from another task', async () => {
		expect(await check()).toContain('"passed":true')
		const result = await check({ allowReuse: true, task: 'another-task', session: 'describe-pr' })
		expect(result).not.toContain('Reused')
		expect(await readFile(join(cwd, '.git/runs'), 'utf8')).toBe('xx')
	})
	it('independent QA executes instead of reusing implementation checks', async () => {
		await check()
		expect(await check({ session: 'independent-qa' })).not.toContain('Reused')
		expect(await readFile(join(cwd, '.git/runs'), 'utf8')).toBe('xx')
	})
	it.each(['commit', 'tracked', 'untracked', 'finding', 'scope', 'command'] as const)(
		'invalidates on changed %s',
		async (change) => {
			await check()
			if (change === 'commit')
				await git(
					'-c',
					'user.name=Test',
					'-c',
					'user.email=test@example.com',
					'commit',
					'--allow-empty',
					'-m',
					'new revision',
				)
			if (change === 'tracked') await writeFile(join(cwd, 'input'), 'changed')
			if (change === 'untracked') await writeFile(join(cwd, 'new-input'), 'new')
			const result = await check({
				allowReuse: true,
				...(change === 'finding' ? { finding: 'review-1' } : {}),
				...(change === 'scope' ? { scope: 'other package' } : {}),
				...(change === 'command' ? { command: command + '; true' } : {}),
			})
			expect(result).not.toContain('Reused')
			if (change === 'tracked' || change === 'untracked') expect(result).toContain('"passed":false')
		},
	)
	it.each(['failure', 'timeout', 'abort'] as const)('never reuses %s evidence', async (kind) => {
		const failing = 'exit 7'
		vi.mocked(runOwnedCommand).mockResolvedValueOnce({
			stdout: '',
			stderr: '',
			exitCode: kind === 'failure' ? 7 : -1,
			timedOut: kind === 'timeout',
			aborted: kind === 'abort',
		})
		expect(await check({ command: failing })).toContain('"passed":false')
		const result = await check({ command: failing, allowReuse: true })
		expect(result).not.toContain('Reused')
		expect(result).toContain('"passed":false')
	})
	it('a later execution error invalidates an earlier success before it throws', async () => {
		await check()
		vi.mocked(runOwnedCommand).mockRejectedValueOnce(new Error('spawn failed'))
		await expect(check()).rejects.toThrow('spawn failed')
		expect(await check({ allowReuse: true })).not.toContain('Reused')
	})
	it('does not certify a command that changes its inputs', async () => {
		expect(await check({ command: 'echo changed >> input' })).toContain('"passed":false')
	})
})

describe('verification lane', () => {
	it('bounds same-checkout concurrency while allowing independent tasks', async () => {
		let active = 0
		let maximum = 0
		const signal = new AbortController().signal
		const work = () =>
			serialVerification('same', signal, async () => {
				maximum = Math.max(maximum, ++active)
				await delay(30)
				active--
			})
		await Promise.all([work(), work(), work()])
		expect(maximum).toBe(1)
		let release = () => {}
		const held = serialVerification(
			'first',
			signal,
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		await delay(10)
		await serialVerification('second', signal, async () => {
			expect(active).toBe(0)
		})
		release()
		await held
	})
	it('a cancelled queued command never executes and releases the lane', async () => {
		const controller = new AbortController()
		const first = serialVerification('same', controller.signal, () => delay(50))
		let executed = false
		const queued = serialVerification('same', controller.signal, async () => {
			executed = true
		})
		controller.abort()
		const cancelled = expect(queued).rejects.toThrow()
		await first.catch(() => {})
		await cancelled
		expect(executed).toBe(false)
		await serialVerification('same', new AbortController().signal, async () => {})
	})
})

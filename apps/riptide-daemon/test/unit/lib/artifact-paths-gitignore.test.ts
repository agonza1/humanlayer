import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { useHermeticGitConfig } from '@humanlayer/git-attribution/testing'
import { afterAll, describe, expect, test } from 'vitest'

import { getArtifactStoragePath, isGitRepository, setupArtifactPaths } from '../../../src/lib/artifact-paths'
import { createMockDaemonServices } from '../../helpers/create-mock-daemon-services'

const execFileAsync = promisify(execFile)
const createdTaskIds: string[] = []
const createdTempDirectories: string[] = []
const daemonRuntime = createMockDaemonServices().daemonRuntime

useHermeticGitConfig()

function uniqueTaskId(): string {
	const taskId = `test-gitignore-${crypto.randomUUID()}`
	createdTaskIds.push(taskId)
	return taskId
}

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'artifact-paths-gitignore-'))
	createdTempDirectories.push(directory)
	return directory
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync('git', args, { cwd })).stdout
}

async function initRepository(): Promise<string> {
	const cwd = await tempDir()
	await runGit(cwd, 'init', '--quiet')
	await runGit(cwd, 'config', 'user.email', 'riptide-tests@example.com')
	await runGit(cwd, 'config', 'user.name', 'Riptide Tests')
	return cwd
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

afterAll(async () => {
	await daemonRuntime.dispose()
	await Promise.all([
		...createdTaskIds.map((taskId) => rm(getArtifactStoragePath(taskId), { recursive: true, force: true })),
		...createdTempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
	])
})

describe('isGitRepository', () => {
	test('true for a .git directory (normal clone)', async () => {
		const cwd = await tempDir()
		await mkdir(join(cwd, '.git'))
		expect(await isGitRepository(cwd)).toBe(true)
	})

	test('true for a .git file (linked worktree)', async () => {
		const cwd = await tempDir()
		await writeFile(join(cwd, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf-8')
		expect(await isGitRepository(cwd)).toBe(true)
	})

	test('false for a plain directory (workspace root)', async () => {
		const cwd = await tempDir()
		expect(await isGitRepository(cwd)).toBe(false)
	})
})

describe('setupArtifactPaths local Git exclusion', () => {
	test('leaves a root .gitignore rule unchanged', async () => {
		const cwd = await initRepository()
		const gitignorePath = join(cwd, '.gitignore')
		const originalContents = '.humanlayer/tasks/\n'
		await writeFile(gitignorePath, originalContents)

		await setupArtifactPaths(cwd, uniqueTaskId(), 'root-rule-task', daemonRuntime)

		expect(await readFile(gitignorePath, 'utf-8')).toBe(originalContents)
	})

	test('leaves .gitignore absent when info/exclude ignores artifacts', async () => {
		const cwd = await initRepository()
		await writeFile(join(cwd, '.git', 'info', 'exclude'), '.humanlayer/tasks/\n')

		await setupArtifactPaths(cwd, uniqueTaskId(), 'info-exclude-task', daemonRuntime)

		expect(await fileExists(join(cwd, '.gitignore'))).toBe(false)
	})

	test('leaves .gitignore absent when core.excludesFile ignores artifacts', async () => {
		const cwd = await initRepository()
		const excludesFile = join(await tempDir(), 'git-excludes')
		await writeFile(excludesFile, '.humanlayer/tasks/\n')
		await runGit(cwd, 'config', 'core.excludesFile', excludesFile)

		await setupArtifactPaths(cwd, uniqueTaskId(), 'configured-exclude-task', daemonRuntime)

		expect(await fileExists(join(cwd, '.gitignore'))).toBe(false)
	})

	test('honors a matching rule when an artifact path is tracked', async () => {
		const cwd = await initRepository()
		const gitignorePath = join(cwd, '.gitignore')
		const originalContents = '.humanlayer/tasks/\n'
		await mkdir(join(cwd, '.humanlayer', 'tasks'), { recursive: true })
		await writeFile(join(cwd, '.humanlayer', 'tasks', 'tracked.txt'), 'tracked\n')
		await writeFile(gitignorePath, originalContents)
		await runGit(cwd, 'add', '--force', '.humanlayer/tasks/tracked.txt')

		await setupArtifactPaths(cwd, uniqueTaskId(), 'tracked-path-task', daemonRuntime)

		expect(await readFile(gitignorePath, 'utf-8')).toBe(originalContents)
	})

	test('leaves a tracked negation in control', async () => {
		const cwd = await initRepository()
		const gitignorePath = join(cwd, '.gitignore')
		const originalContents = '.humanlayer/tasks/\n!.humanlayer/tasks/\n'
		await writeFile(gitignorePath, originalContents)
		await runGit(cwd, 'add', '.gitignore')

		await setupArtifactPaths(cwd, uniqueTaskId(), 'negated-rule-task', daemonRuntime)

		expect(await readFile(gitignorePath, 'utf-8')).toBe(originalContents)
		expect(await runGit(cwd, 'status', '--porcelain', '--untracked-files=all')).toContain(
			'?? .humanlayer/tasks/negated-rule-task',
		)
	})

	test('keeps a tracked .gitignore and Git status clean', async () => {
		const cwd = await initRepository()
		const gitignorePath = join(cwd, '.gitignore')
		const originalContents = 'node_modules/\n'
		await writeFile(gitignorePath, originalContents)
		await runGit(cwd, 'add', '.gitignore')
		await runGit(cwd, 'commit', '--quiet', '-m', 'initial commit')

		const { symlinkPath } = await setupArtifactPaths(cwd, uniqueTaskId(), 'unignored-task', daemonRuntime)

		expect(await fileExists(symlinkPath)).toBe(true)
		expect(await readFile(gitignorePath, 'utf-8')).toBe(originalContents)
		expect(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf-8')).toContain('/.humanlayer/tasks/\n')
		expect(await runGit(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe('')
	})

	test('preserves existing exclusions and writes one rule across concurrent and repeated setup', async () => {
		const cwd = await initRepository()
		const excludePath = join(cwd, '.git', 'info', 'exclude')
		await writeFile(excludePath, '# Existing exclusions\n/build/')
		const taskIds = [uniqueTaskId(), uniqueTaskId(), uniqueTaskId()]

		await Promise.all(taskIds.map((taskId) => setupArtifactPaths(cwd, taskId, taskId, daemonRuntime)))
		await setupArtifactPaths(cwd, taskIds[0]!, taskIds[0]!, daemonRuntime)

		expect(await readFile(excludePath, 'utf-8')).toBe('# Existing exclusions\n/build/\n/.humanlayer/tasks/\n')
		expect(await fileExists(join(cwd, '.gitignore'))).toBe(false)
		expect(await runGit(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe('')
	})

	test('uses the common Git exclude file in a linked worktree', async () => {
		const root = await tempDir()
		const repository = join(root, 'repository')
		const worktree = join(root, 'linked-worktree')
		await mkdir(repository)
		await runGit(repository, 'init', '--quiet')
		await runGit(repository, 'config', 'user.email', 'riptide-tests@example.com')
		await runGit(repository, 'config', 'user.name', 'Riptide Tests')
		await writeFile(join(repository, 'README.md'), 'repository\n')
		await runGit(repository, 'add', 'README.md')
		await runGit(repository, 'commit', '--quiet', '-m', 'initial commit')
		await runGit(repository, 'worktree', 'add', '--quiet', '-b', 'linked-test', worktree)

		await setupArtifactPaths(worktree, uniqueTaskId(), 'linked-worktree-task', daemonRuntime)

		expect(await fileExists(join(worktree, '.gitignore'))).toBe(false)
		expect(await readFile(join(repository, '.git', 'info', 'exclude'), 'utf-8')).toContain('/.humanlayer/tasks/\n')
		expect(await runGit(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
	})

	test('keeps the symlink usable and skips .gitignore after a fatal Git check', async () => {
		const cwd = await tempDir()
		await writeFile(join(cwd, '.git'), 'not a valid gitdir file\n')

		const { symlinkPath } = await setupArtifactPaths(cwd, uniqueTaskId(), 'fatal-git-task', daemonRuntime)

		expect(await fileExists(symlinkPath)).toBe(true)
		expect(await fileExists(join(cwd, '.gitignore'))).toBe(false)
	})

	test('skips .gitignore when the cwd is not a git repo (workspace root launch)', async () => {
		const cwd = await tempDir()

		const { symlinkPath } = await setupArtifactPaths(cwd, uniqueTaskId(), 'workspace-root-task', daemonRuntime)

		expect(await fileExists(symlinkPath)).toBe(true)
		expect(await fileExists(join(cwd, '.gitignore'))).toBe(false)
	})
})

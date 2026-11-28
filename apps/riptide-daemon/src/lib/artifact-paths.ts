import { lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ensureArtifactsGitExcluded } from '@/effects/check-artifacts-gitignored'
import type { DaemonRuntime } from '@/effects/runtime'
import { logger } from '@/logger'

import { getArtifactStoragePath, getArtifactSymlinkPath } from './artifact-location'

export { getArtifactStoragePath, getArtifactSymlinkPath } from './artifact-location'

/**
 * Ensure the symlink from in-repo path to UUID storage.
 * Creates storage directory, parent directories, and symlink if needed.
 * If symlink exists but points elsewhere, updates it.
 */
export async function ensureArtifactSymlink(
	cwd: string,
	taskId: string,
	taskSlug: string,
): Promise<{ storagePath: string; symlinkPath: string }> {
	const storagePath = getArtifactStoragePath(taskId)
	const symlinkPath = getArtifactSymlinkPath(cwd, taskSlug)

	// Ensure storage exists
	await mkdir(storagePath, { recursive: true })

	// Ensure parent directory exists
	await mkdir(dirname(symlinkPath), { recursive: true })

	// Check what exists at the symlink path
	try {
		const stats = await lstat(symlinkPath)
		if (stats.isSymbolicLink()) {
			// Symlink exists — check if it points to the correct storage
			const existingTarget = await readlink(symlinkPath)
			if (existingTarget === storagePath) {
				logger.debug({ taskId, taskSlug, symlinkPath }, 'Symlink already exists and is correct')
				return { storagePath, symlinkPath }
			}
			// Symlink points elsewhere — remove and recreate
			logger.info({ taskId, taskSlug, existingTarget, storagePath }, 'Updating symlink target')
			await unlink(symlinkPath)
		} else if (stats.isDirectory()) {
			// Plain directory exists (created by tauri before this fix) — migrate contents to UUID storage
			logger.info({ taskId, taskSlug, symlinkPath, storagePath }, 'Migrating plain directory to symlink')
			const files = await readdir(symlinkPath)
			for (const file of files) {
				await rename(join(symlinkPath, file), join(storagePath, file))
			}
			await rm(symlinkPath, { recursive: true })
		} else {
			// Something else (regular file) — remove it
			logger.warn({ taskId, taskSlug, symlinkPath }, 'Unexpected file at symlink path, removing')
			await unlink(symlinkPath)
		}
	} catch (error) {
		// Path doesn't exist — that's fine, fall through to create
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error
		}
	}

	// Create symlink
	try {
		await symlink(storagePath, symlinkPath)
		logger.info({ taskId, taskSlug, symlinkPath, storagePath }, 'Created artifact symlink')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			// Another concurrent caller created the symlink — verify it's correct
			const existingTarget = await readlink(symlinkPath)
			if (existingTarget === storagePath) {
				logger.debug({ taskId, taskSlug }, 'Symlink created by concurrent caller, target is correct')
			} else {
				throw new Error(`Concurrent symlink creation conflict: expected ${storagePath}, got ${existingTarget}`)
			}
		} else {
			throw error
		}
	}
	return { storagePath, symlinkPath }
}

/**
 * Check whether a directory is a git repository (or worktree).
 * Worktrees have a `.git` *file* pointing at the parent repo, so any `.git`
 * entry counts. A multi-repo workspace root has no `.git` at all.
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
	try {
		await lstat(join(cwd, '.git'))
		return true
	} catch {
		return false
	}
}

/**
 * Set up artifact directory structure for a task.
 * 1. Ensure symlink from {cwd}/.humanlayer/tasks/{slug}/ → UUID storage (also creates storage)
 * 2. Exclude that directory through Git's local info/exclude if it is not already ignored.
 *    Skip the Git step at a multi-repo workspace root.
 *
 * The symlink (step 1) is required for artifacts to sync, so its failures
 * propagate. Git exclusion is best-effort and never edits tracked files.
 */
export async function setupArtifactPaths(
	cwd: string,
	taskId: string,
	taskSlug: string,
	daemonRuntime: DaemonRuntime,
): Promise<{ storagePath: string; symlinkPath: string }> {
	const { storagePath, symlinkPath } = await ensureArtifactSymlink(cwd, taskId, taskSlug)

	try {
		if (await isGitRepository(cwd)) {
			await daemonRuntime.runPromise(ensureArtifactsGitExcluded({ cwd }))
		} else {
			logger.debug({ cwd }, 'Skipping artifact Git exclusion at a non-repository workspace root')
		}
	} catch (error) {
		logger.warn({ cwd, error }, 'Failed to configure local Git exclusion for artifacts')
	}

	return { storagePath, symlinkPath }
}

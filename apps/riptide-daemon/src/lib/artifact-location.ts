import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Get the UUID-based artifact storage path.
 * ~/.humanlayer/riptide/artifacts/{taskId}/
 */
export function getArtifactStoragePath(taskId: string): string {
	return join(homedir(), '.humanlayer', 'riptide', 'artifacts', taskId)
}

/**
 * Get the in-repo symlink path for artifacts.
 * {cwd}/.humanlayer/tasks/{taskSlug}/
 */
export function getArtifactSymlinkPath(cwd: string, taskSlug: string): string {
	return join(cwd, '.humanlayer', 'tasks', taskSlug)
}

import { resolve } from 'node:path'

import { ensureArtifactGitExclude } from '@humanlayer/session-sdk-artifacts'
import { Effect } from 'effect'

import { GitCommandRunner } from './services/task-diff/git-command-runner.service'

const ARTIFACTS_GIT_PATH = '.humanlayer/tasks'

export type ArtifactIgnoreStatus = 'ignored' | 'not-ignored'

export const checkArtifactsGitignored = Effect.fn('artifacts.check_git_ignore_status')(function* (input: {
	readonly cwd: string
}) {
	const gitCommandRunner = yield* GitCommandRunner
	const result = yield* gitCommandRunner.run(['check-ignore', '--quiet', '--no-index', '--', ARTIFACTS_GIT_PATH], {
		cwd: input.cwd,
		okExitCodes: [0, 1],
	})
	const status: ArtifactIgnoreStatus = result.exitCode === 0 ? 'ignored' : 'not-ignored'

	yield* Effect.logDebug('Checked artifact Git ignore status').pipe(
		Effect.annotateLogs({ cwd: input.cwd, artifactPath: ARTIFACTS_GIT_PATH, status }),
	)

	return status
})

export const ensureArtifactsGitExcluded = Effect.fn('artifacts.ensure_git_exclude')(function* (input: {
	readonly cwd: string
}) {
	if ((yield* checkArtifactsGitignored(input)) === 'ignored') return

	const git = yield* GitCommandRunner
	const { stdout } = yield* git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: input.cwd })
	const excludePath = resolve(input.cwd, stdout.trim())
	yield* Effect.tryPromise(() => ensureArtifactGitExclude(excludePath))
})

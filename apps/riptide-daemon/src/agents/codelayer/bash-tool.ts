import { defineTool } from '@humanlayer/agentlayer-core'
import { BASH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import z from 'zod/v4'

import { runOwnedCommand } from './owned-process'
import { executeVerification } from './verification'

export const VERIFICATION_INSTRUCTIONS = `Classify each Bash call explicitly. Use execution=verification for tests, typechecks, lint, format checks, builds, or other expensive validation; execute one check per call, never shell-background checks. Use execution=ordinary for ordinary commands. Verification calls share a serial lane within this task checkout; other tools and tasks remain concurrent. Set scope to the package/path checked and finding to the current finding ID (empty if none). A new finding must change finding for every affected check. Describe PR reuses only successful clean exact-HEAD evidence with matching command, directory, scope, and finding. Dirty checks still report actual outcomes but are not reusable. Independent QA never reuses implementation evidence. Keep inner parallelism modest; use HUMANLAYER_VERIFICATION_CONCURRENCY (default 2) for runner concurrency flags. Do not replace required hosted CI or independent review with local evidence.`

export function createOwnedBashTool(options: {
	cwd: string
	env: NodeJS.ProcessEnv
	task: string
	session: string
	allowReuse: boolean
}) {
	const configured = Number(process.env.HUMANLAYER_VERIFICATION_CONCURRENCY ?? 2)
	const concurrency = String(Number.isInteger(configured) && configured > 0 ? configured : 2)
	const verificationEnv = {
		...options.env,
		HUMANLAYER_VERIFICATION_CONCURRENCY: concurrency,
		CARGO_BUILD_JOBS: concurrency,
		RAYON_NUM_THREADS: concurrency,
		GOMAXPROCS: concurrency,
		CMAKE_BUILD_PARALLEL_LEVEL: concurrency,
	}
	return defineTool({
		name: 'bash',
		description: `${BASH_DESCRIPTION}\n${VERIFICATION_INSTRUCTIONS}`,
		input: z.object({
			command: z.string(),
			timeout: z.number().positive().default(120_000),
			workdir: z.string().optional(),
			description: z.string().optional(),
			execution: z.enum(['ordinary', 'verification']),
			scope: z.string().default('repository'),
			finding: z.string().default(''),
		}),
		execute: async (input, ctx) => {
			const cwd = input.workdir ?? options.cwd
			if (input.execution === 'verification') {
				return executeVerification({ ...options, ...input, env: verificationEnv, cwd, signal: ctx.signal })
			}
			const result = await runOwnedCommand(input.command, {
				cwd,
				env: options.env,
				timeout: input.timeout,
				signal: ctx.signal,
			})
			return (
				`Exit code: ${result.exitCode}\n${result.stdout}\nSTDERR: ${result.stderr}` +
				(result.timedOut ? '\nCommand timed out; owned process cleanup completed.' : '') +
				(result.aborted ? '\nCommand cancelled; owned process cleanup completed.' : '')
			)
		},
	})
}

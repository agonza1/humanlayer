import type { ToolContext } from '@humanlayer/agentlayer-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOwnedBashTool } from './bash-tool'
import { runOwnedCommand } from './owned-process'
import { executeVerification } from './verification'

vi.mock('./owned-process', () => ({ runOwnedCommand: vi.fn() }))
vi.mock('./verification', () => ({ executeVerification: vi.fn() }))

const ctx: ToolContext = {
	signal: new AbortController().signal,
	getContextWindow: () => [],
	updateContextWindow: () => {},
	stop: () => ({ type: 'stop' }),
	getContextWindowTokens: () => 0,
	getContextWindowLimit: () => undefined,
}
const options = {
	cwd: '/task',
	env: { ATTRIBUTION: 'session' },
	task: 'task',
	session: 'implementation',
	allowReuse: false,
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(runOwnedCommand).mockResolvedValue({
		stdout: 'ok',
		stderr: '',
		exitCode: 0,
		timedOut: false,
		aborted: false,
	})
	vi.mocked(executeVerification).mockResolvedValue('verified')
})

describe('Bash execution seam', () => {
	it('requires an explicit class rather than guessing from command strings', () => {
		const tool = createOwnedBashTool(options)
		expect(tool.input.safeParse({ command: 'anything' }).success).toBe(false)
	})
	it('routes verification through its lane with configurable modest compiler concurrency', async () => {
		vi.stubEnv('HUMANLAYER_VERIFICATION_CONCURRENCY', '1')
		try {
			const tool = createOwnedBashTool(options)
			await tool.execute(
				tool.input.parse({
					command: 'some check',
					execution: 'verification',
					scope: 'package',
					finding: 'review-1',
				}),
				ctx,
			)
			expect(executeVerification).toHaveBeenCalledWith(
				expect.objectContaining({
					allowReuse: false,
					scope: 'package',
					finding: 'review-1',
					env: expect.objectContaining({
						CARGO_BUILD_JOBS: '1',
						RAYON_NUM_THREADS: '1',
						GOMAXPROCS: '1',
						HUMANLAYER_VERIFICATION_CONCURRENCY: '1',
						ATTRIBUTION: 'session',
					}),
				}),
			)
			expect(runOwnedCommand).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllEnvs()
		}
	})
	it('ordinary commands bypass the verification lane without compiler overrides', async () => {
		const tool = createOwnedBashTool(options)
		await tool.execute(tool.input.parse({ command: 'git status', execution: 'ordinary' }), ctx)
		expect(executeVerification).not.toHaveBeenCalled()
		expect(runOwnedCommand).toHaveBeenCalledWith(
			'git status',
			expect.objectContaining({ env: options.env, signal: ctx.signal }),
		)
	})
	it('does not hide cancellation or timeout as a pass', async () => {
		vi.mocked(runOwnedCommand).mockResolvedValueOnce({
			stdout: '',
			stderr: '',
			exitCode: -1,
			timedOut: true,
			aborted: false,
		})
		const tool = createOwnedBashTool(options)
		expect(await tool.execute(tool.input.parse({ command: 'command', execution: 'ordinary' }), ctx)).toContain(
			'Command timed out',
		)
	})
})

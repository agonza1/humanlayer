import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { startState, userMessage, type ApprovalHook } from '@humanlayer/agentlayer-core'
import { createCodelayerAgent } from '@humanlayer/codelayer'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOwnedBashTool } from './bash-tool'
import { runOwnedCommand } from './owned-process'

vi.mock('./owned-process', () => ({ runOwnedCommand: vi.fn() }))

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const input = { command: 'integration fixture', execution: 'ordinary', workdir: '/fixture-directory' }

async function run(approval: ApprovalHook, output: string) {
	vi.mocked(runOwnedCommand).mockResolvedValue({
		stdout: output,
		stderr: '',
		exitCode: 0,
		timedOut: false,
		aborted: false,
	})
	let calls = 0
	const model = new MockLanguageModelV3({
		modelId: 'gpt-5-test',
		doStream: async () => {
			if (++calls === 1)
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'stream-start', warnings: [] },
							{
								type: 'tool-call',
								toolCallId: 'integration-bash',
								toolName: 'bash',
								input: JSON.stringify(input),
							},
							{ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
						],
					}),
				}
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'text-start', id: 'done' },
						{ type: 'text-delta', id: 'done', delta: 'done' },
						{ type: 'text-end', id: 'done' },
						{ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
					],
				}),
			}
		},
	})
	const bash = createOwnedBashTool({
		cwd: '/default-directory',
		env: { ATTRIBUTION_FIXTURE: 'session' },
		task: 'fixture',
		session: 'fixture',
		allowReuse: false,
	})
	const agent = await createCodelayerAgent({
		cwd: import.meta.dirname,
		model,
		additionalTools: { bash },
		hooks: { approval: [approval] },
	})
	return agent.run({ state: startState([userMessage('Run the fixture')]) }).result
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('real SDK Bash override integration (process execution mocked)', () => {
	it('denied approval prevents the override from spawning', async () => {
		const approval = vi.fn<ApprovalHook>((ctx) => ctx.deny('fixture denied'))
		await run(approval, 'not executed')
		expect(approval).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: 'bash', input: expect.objectContaining(input) }),
		)
		expect(runOwnedCommand).not.toHaveBeenCalled()
	})
	it('approved calls preserve workdir, session environment and cancellation signal', async () => {
		const approval = vi.fn<ApprovalHook>((ctx) => ctx.next())
		const result = await run(approval, 'ordinary output')
		expect(result.finishReason).not.toBe('error')
		expect(approval).toHaveBeenCalled()
		expect(runOwnedCommand).toHaveBeenCalledWith(
			input.command,
			expect.objectContaining({
				cwd: input.workdir,
				env: { ATTRIBUTION_FIXTURE: 'session' },
				timeout: 120_000,
				signal: expect.any(AbortSignal),
			}),
		)
		expect(JSON.stringify(result.state.messages)).toContain('ordinary output')
	})
	it('the unchanged SDK filesystem hooks spool full output and truncate the model result', async () => {
		const output = Array.from({ length: 3000 }, (_, index) => `fixture-line-${index}`).join('\n')
		const result = await run((ctx) => ctx.next(), output)
		const message = result.state.messages.find((entry) => entry.role === 'tool')
		const serialized = JSON.stringify(message)
		expect(serialized).toContain('Output truncated. Full output saved to')
		const path = /Full output saved to ([^ )"\\]+)/.exec(serialized)?.[1]
		expect(path).toBeTruthy()
		if (!path) throw new Error('Missing spooled output path')
		try {
			expect(await readFile(path, 'utf8')).toBe(`Exit code: 0\n${output}\nSTDERR: `)
			expect(serialized).not.toContain('fixture-line-0\\n')
			expect(serialized).toContain('fixture-line-2999')
		} finally {
			await rm(dirname(path), { recursive: true, force: true })
		}
	})
})

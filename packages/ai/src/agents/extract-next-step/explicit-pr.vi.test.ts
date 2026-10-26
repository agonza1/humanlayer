import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateText, resolveModel } = vi.hoisted(() => ({
	generateText: vi.fn(),
	resolveModel: vi.fn(),
}))
vi.mock('ai', () => ({ generateText, Output: { object: vi.fn() } }))
vi.mock('../../providers', () => ({ resolveModel }))

import { extractNextStep } from './extract-next-step'

// The exact final section requested by the Small task launcher.
const nextStep =
	'### Next steps\n\n' +
	'To create a PR, use the button below, or create a new session with the following command:\n\n' +
	'```\n/rpi:describe-pr\n```'

beforeEach(() => {
	vi.clearAllMocks()
	generateText.mockRejectedValue(new Error('No API credential'))
})

describe('explicit Small-task PR handoff', () => {
	it.each([nextStep, `Implemented and verified.\n\n${nextStep}`, `${nextStep}\n\n`, nextStep.replace(/\n/g, '\r\n')])(
		'recognizes the requested final section without resolving or calling a model: %s',
		async (message) => {
			const result = await extractNextStep(message)
			expect(result).toEqual({
				parsedAt: expect.any(Number),
				extraction: {
					type: 'next_step_found',
					nextStepPrompt: '/rpi:describe-pr',
					nextStepSummary: 'describe-pr',
					nextStepType: 'describe-pr',
					taskReference: '',
				},
			})
			expect(resolveModel).not.toHaveBeenCalled()
			expect(generateText).not.toHaveBeenCalled()
		},
	)

	it.each([
		'Blocked: cannot finish implementation.',
		'The command is /rpi:describe-pr.',
		'```\n/rpi:describe-pr\n```',
		`${nextStep}\n\nShould I proceed?`,
		nextStep.replace('/rpi:describe-pr', '/rpi:implement-plan'),
		nextStep.replace('/rpi:describe-pr', '/rpi:describe-pr && other-command'),
		nextStep
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n'),
	])('keeps freeform, incomplete or ambiguous output on the existing extraction path: %s', async (message) => {
		const result = await extractNextStep(message)
		expect(generateText).toHaveBeenCalledOnce()
		expect(result.extraction.type).toBe('no_next_step')
		expect(result.extractionError).toBe('No API credential')
	})

	it('preserves successful model extraction for other skill prompts', async () => {
		generateText.mockResolvedValue({
			output: {
				found: true,
				nextStepPrompt: 'use the rpi:implement-plan skill for task-1',
				nextStepSummary: 'implement: task-1',
				nextStepType: 'rpi:implement-plan',
				taskReference: 'task-1',
			},
		})
		const result = await extractNextStep('A freeform planning handoff')
		expect(result.extraction).toMatchObject({ type: 'next_step_found', nextStepType: 'implement-plan' })
	})
})

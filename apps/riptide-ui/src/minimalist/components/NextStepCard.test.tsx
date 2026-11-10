import type { Session } from '@humanlayer/db/tables/sessions'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NextStepCard } from './NextStepCard'

const { launch, navigate } = vi.hoisted(() => ({ launch: vi.fn(), navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/orpc/client', () => ({ useRiptideApi: () => ({ client: {} }) }))
vi.mock('@/minimalist/lib/launch', () => ({ launchInTask: launch }))
vi.mock('@/minimalist/lib/use-action', () => ({
	useAction: () => ({
		pending: false,
		run: async (run: () => Promise<unknown>) => {
			await run()
			return true
		},
	}),
}))
vi.mock('@/hooks/live-queries/useExistingSessionForNextStep', () => ({
	useExistingSessionForNextStep: () => ({ siblingSessionId: null }),
}))

const session = (id: string) =>
	({
		id,
		task_id: 'task',
		host_id: 'host',
		working_directory: '/repo',
		created_at: new Date(0),
		next_step_suggestions: [
			{
				parsedAt: 0,
				extraction: {
					type: 'next_step_found',
					nextStepPrompt: 'use the rpi:create-plan skill for the task',
					nextStepSummary: 'Proceed to the plan',
					nextStepType: 'create-plan',
					taskReference: 'task',
				},
			},
		],
	}) as unknown as Session

const task = { id: 'task', workspace_id: null }
const host = { online: true } as Parameters<typeof NextStepCard>[0]['host']

beforeEach(() => {
	localStorage.clear()
	vi.clearAllMocks()
})
afterEach(cleanup)

describe('NextStepCard', () => {
	it.each([
		['create-plan', { executionPhase: null, planningSkill: 'rpi:plan' }],
		['implement-plan', { executionPhase: 'implementation' }],
		['describe-pr', { executionPhase: 'review' }],
	] as const)('launches %s with explicit work entry in the existing task', async (nextStepType, entry) => {
		const current = session('phase')
		current.next_step_suggestions = [
			{
				parsedAt: 0,
				extraction: {
					type: 'next_step_found',
					nextStepType,
					nextStepPrompt: 'Continue the accepted task',
					nextStepSummary: 'Continue',
					taskReference: 'task',
				},
			},
		]
		render(<NextStepCard session={current} task={task} host={host} />)
		fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
		await waitFor(() => expect(launch).toHaveBeenCalledOnce())
		expect(launch.mock.calls[0]?.[1]).toBe(task)
		expect(launch.mock.calls[0]?.[2]).toMatchObject({
			...entry,
			hostId: 'host',
			text: `/rpi:${nextStepType} Continue the accepted task`,
			sessionId: expect.any(String),
			eventId: expect.any(String),
		})
	})
	it('suppresses enrolled Describe PR rendering and its keyboard dispatch', () => {
		const current = session('enrolled')
		current.next_step_suggestions = [
			{
				parsedAt: 0,
				extraction: {
					type: 'next_step_found',
					nextStepType: 'describe-pr',
					nextStepPrompt: 'Describe',
					nextStepSummary: 'Describe',
					taskReference: 'task',
				},
			},
		]
		render(<NextStepCard session={current} task={{ ...task, workflow_revision: 1n }} host={host} />)
		expect(screen.queryByRole('group', { name: 'Next step' })).toBeNull()
		fireEvent.keyDown(window, { key: 'Enter', shiftKey: true, metaKey: true })
		expect(launch).not.toHaveBeenCalled()
		expect(navigate).not.toHaveBeenCalled()
	})
	it('folds into a thin row for that session and opens again from it', () => {
		const { rerender } = render(<NextStepCard session={session('a')} task={task} host={host} />)
		expect(screen.getByRole('group', { name: 'Next step' })).toHaveTextContent('Write the plan')
		fireEvent.click(screen.getByRole('button', { name: 'Hide next step' }))
		expect(screen.queryByRole('group', { name: 'Next step' })).toBeNull()
		const row = screen.getByRole('button', { name: 'Show next step: Write the plan' })

		// Another session still shows its card; coming back keeps this one folded.
		rerender(<NextStepCard session={session('b')} task={task} host={host} />)
		expect(screen.getByRole('group', { name: 'Next step' })).toBeInTheDocument()
		rerender(<NextStepCard session={session('a')} task={task} host={host} />)
		fireEvent.click(screen.getByRole('button', { name: 'Show next step: Write the plan' }))
		expect(screen.getByRole('group', { name: 'Next step' })).toBeInTheDocument()
		expect(row.isConnected).toBe(false)
	})
})

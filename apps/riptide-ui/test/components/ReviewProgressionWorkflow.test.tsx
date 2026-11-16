import type { NextStepSuggestion } from '@humanlayer/db/zodschemas/next-step'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useEventRowNextStep } from '@/components/conversation-stream/hooks/useEventRowNextStep'
import { NextStepButton } from '@/components/conversation-stream/NextStepButton'
import { LauncherWorkflowControlWired } from '@/components/launcher-v3/controls/LauncherWorkflowControlWired'
import { useTaskNextStep } from '@/hooks/task-detail/useTaskNextStep'
import { workEntryForLabel } from '@/lib/review-progression'
import { createLauncherV3DefaultValues, toLaunchCommand } from '@/modules/launcher-v3/launcher-v3-form'

const { state, navigate, proceed } = vi.hoisted(() => ({
	state: { revision: 1n, sibling: null as string | null, nextStepType: 'describe-pr' },
	navigate: vi.fn(),
	proceed: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@humanlayer/react-hotkeys-hook', () => ({ useHotkeys: vi.fn() }))
vi.mock('@/components/providers/SyncProvider', () => ({ useSync: () => ({}), useSyncInternal: vi.fn() }))
vi.mock('@tanstack/react-db', async (original) => ({
	...(await original<typeof import('@tanstack/react-db')>()),
	useLiveQuery: () => ({ data: [{ workflow_revision: state.revision }] }),
}))
vi.mock('@/hooks/live-queries/useExistingSessionForNextStep', () => ({
	useExistingSessionForNextStep: () => ({ siblingSessionId: state.sibling }),
}))
vi.mock('@/hooks/live-queries/useTaskHasNextStep', () => ({
	useTaskHasNextStep: () => ({ nextStepData: { nextStepType: state.nextStepType, taskId: 'task' } }),
}))

function WorkflowForm() {
	const form = useForm({
		defaultValues: createLauncherV3DefaultValues({
			hostId: 'host',
			workflowType: 'prd_tdd',
			autoAdvance: true,
			reviewEnrollmentId: 'personal',
			reviewReturnRouteRef: 'origin',
		}),
	})
	return (
		<>
			<LauncherWorkflowControlWired control={form.control} />
			<output data-testid="command">{JSON.stringify(toLaunchCommand(form.watch()))}</output>
		</>
	)
}

function StandardNextStep() {
	const suggestion: NextStepSuggestion = {
		parsedAt: 0,
		extraction: {
			type: 'next_step_found',
			nextStepType: 'describe-pr',
			nextStepPrompt: 'Describe',
			nextStepSummary: 'Describe',
			taskReference: 'task',
		},
	}
	const action = useEventRowNextStep({
		event: null,
		taskId: 'task',
		sessionId: 'session',
		targetLabel: 'rpi:describe-pr',
		nextStepName: 'Describe PR',
		isAutoAdvanceEnabled: false,
		onProceedToNextStep: proceed,
	})
	return (
		<NextStepButton
			suggestion={suggestion}
			eventId="event"
			isFocused
			disabled={action.nextStepDisabled}
			onProceed={() => action.handleProceedToNextStep('event', suggestion)}
		/>
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	state.revision = 1n
	state.sibling = null
	state.nextStepType = 'describe-pr'
})

describe('standard workflow rendering', () => {
	it('does not infer enrollment from saved references; explicit selection chooses same-session Small delivery', () => {
		render(<WorkflowForm />)
		const checkbox = screen.getByRole('checkbox', {
			name: 'Same-session delivery with review enrollment',
			hidden: true,
		})
		expect(checkbox).not.toBeChecked()
		expect(screen.getByTestId('command').textContent).not.toContain('reviewProgressionEnrollment')
		fireEvent.click(checkbox)
		expect(checkbox).toBeChecked()
		expect(screen.getByTestId('command').textContent).toContain(
			'"reviewProgressionEnrollment":{"enrollmentId":"personal","returnRouteRef":"origin"}',
		)
		expect(screen.getByTestId('command').textContent).toContain('"autoAdvanceImplementationToPr":false')
		expect(screen.getByText(/Host: host/)).toHaveTextContent('Enrollment: personal. Route: origin.')
		fireEvent.click(checkbox)
		expect(screen.getByTestId('command').textContent).not.toContain('reviewProgressionEnrollment')
	})
})

describe('standard next-step suppression', () => {
	it.each([null, 'existing-review'])('disables Describe PR for enrolled tasks with sibling %s', (sibling) => {
		state.sibling = sibling
		render(<StandardNextStep />)
		const button = screen.getByRole('button')
		expect(button).toBeDisabled()
		fireEvent.click(button)
		expect(proceed).not.toHaveBeenCalled()
		expect(navigate).not.toHaveBeenCalled()
	})
	it('keeps the stock unenrolled Describe PR action', () => {
		state.revision = 0n
		render(<StandardNextStep />)
		fireEvent.click(screen.getByRole('button'))
		expect(proceed).toHaveBeenCalledOnce()
	})
	it('blocks direct task-detail invocation for enrolled Describe PR, even with a sibling', () => {
		state.sibling = 'existing-review'
		const { result } = renderHook(() =>
			useTaskNextStep({ taskId: 'task', canCreateSession: true, editingSessionId: null }),
		)
		expect(result.current.nextStepData).toBeNull()
		result.current.handleProceedToNextStep()
		expect(navigate).not.toHaveBeenCalled()
	})
	it.each([
		['create-plan', 'rpi:plan', { executionPhase: null, planningSkill: 'rpi:plan' }],
		['implement-plan', 'rpi:implementation', { executionPhase: 'implementation' }],
	] as const)('preserves task and the explicit %s draft intent', (type, label, entry) => {
		state.nextStepType = type
		const { result } = renderHook(() =>
			useTaskNextStep({ taskId: 'task', canCreateSession: true, editingSessionId: null }),
		)
		result.current.handleProceedToNextStep()
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({ to: '/sessions/draft', search: expect.objectContaining({ taskId: 'task' }) }),
		)
		expect(result.current.nextStepTargetLabel).toBe(label)
		expect(workEntryForLabel(label)).toEqual(entry)
	})
})

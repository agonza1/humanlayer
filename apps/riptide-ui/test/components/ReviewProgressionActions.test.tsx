import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContinueSessionInputPure, type ContinueSessionInputPureProps } from '@/components/ContinueSessionInput'
import { useDevelopmentResume } from '@/hooks/useSessionActions'
import { WiredTaskDetails } from '@/minimalist/components/TaskDetails'

const { request, state } = vi.hoisted(() => ({
	request: vi.fn(),
	state: { userId: 'owner', session: {} as Record<string, unknown> },
}))
vi.mock('@/orpc/client', () => ({
	useRiptideApi: () => ({
		client: { sessions: { v2: { continue: request } } },
		queryClient: { projectWorkspaces: { getStatus: { queryOptions: () => ({}) } } },
	}),
}))
vi.mock('@/hooks/useRepositorySourceLaunchGuard', () => ({ useRepositorySourceLaunchGuard: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@humanlayer/ui/components/rich-text-editor', () => ({ RichTextEditor: () => null }))
vi.mock('@/hooks/useFileMentionSuggestion', () => ({ useFileMentionSuggestion: () => ({}) }))
vi.mock('@/hooks/useIsNarrow', () => ({ useIsNarrow: () => false }))
vi.mock('@/components/SendCommentsSplitButton', () => ({ SendCommentsSplitButton: () => null }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: state.userId } }) }))
vi.mock('@/hooks/useOrgMembers', () => ({ useOrgMembers: () => ({ membersMap: new Map() }) }))
vi.mock('@/components/providers/SyncProvider', () => ({ useSync: () => ({}), useSyncInternal: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }))
vi.mock('@tanstack/react-db', async (original) => ({
	...(await original<typeof import('@tanstack/react-db')>()),
	useLiveQuery: () => ({ data: [] }),
}))
vi.mock('@/minimalist/lib/data', () => ({
	useTask: () => ({
		task: { id: 'task', resource_owner_user_id: 'owner', created_by: 'owner', created_at: 1n },
		sessions: [state.session],
	}),
	useProjects: () => ({ data: [] }),
	useHost: () => ({}),
	taskBranch: () => null,
}))
vi.mock('@/minimalist/lib/task-workflow', () => ({
	useTaskWorkflow: () => ({ current: 'freeform', canChange: false }),
	workflowOption: () => ({ label: 'Small' }),
}))

const session = {
	id: 'session',
	task_id: 'task',
	created_by: 'owner',
	resource_owner_user_id: 'owner',
	archived: false,
	status: 'ready_for_input',
	execution_phase: 'review' as const,
	execution_phase_at: 1n,
}
beforeEach(() => {
	vi.clearAllMocks()
	request.mockResolvedValue({ kind: 'continued', transactionId: 'tx' })
	state.userId = 'owner'
	state.session = { ...session }
})

describe('retained resume action', () => {
	it('retries uncertain responses with the same IDs and exact payload, then suppresses a duplicate success', async () => {
		request.mockRejectedValueOnce(new Error('Lost response'))
		const { result, rerender } = renderHook(({ entry }) => useDevelopmentResume(entry, true), {
			initialProps: { entry: session },
		})
		await act(() => result.current.resume())
		expect(result.current.error).toMatch(/^Could not resume development/)
		const first = request.mock.calls[0]?.[0]
		await act(() => result.current.resume())
		expect(request.mock.calls[1]?.[0]).toEqual(first)
		expect(first).toMatchObject({
			sessionId: 'session',
			executionPhase: 'implementation',
			intent: 'send',
			messageId: expect.any(String),
			eventId: expect.any(String),
		})
		await act(() => result.current.resume())
		expect(request).toHaveBeenCalledTimes(2)
		rerender({ entry: { ...session, execution_phase_at: 3n } })
		await act(() => result.current.resume())
		expect(request.mock.calls[2]?.[0].eventId).not.toBe(first.eventId)
	})
	it('locks concurrent clicks before the first response and reports typed rejections', async () => {
		let finish: ((value: unknown) => void) | undefined
		request.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const { result } = renderHook(() => useDevelopmentResume(session, true))
		let pending: Promise<void> | undefined
		act(() => {
			pending = result.current.resume()
			void result.current.resume()
		})
		expect(request).toHaveBeenCalledTimes(1)
		expect(result.current.pending).toBe(true)
		await act(async () => {
			finish?.({ kind: 'rejected', reason: 'forbidden' })
			await pending
		})
		expect(result.current.pending).toBe(false)
		expect(result.current.error).toMatch(/^Could not resume development/)
	})
	it.each(['running', 'failed', 'lost', 'needs_approval'])('cannot resume a %s session', async (status) => {
		const { result } = renderHook(() => useDevelopmentResume({ ...session, status }, true))
		await act(() => result.current.resume())
		expect(request).not.toHaveBeenCalled()
	})
	it('checks management authority at invocation', async () => {
		const { result } = renderHook(() => useDevelopmentResume(session, false))
		await act(() => result.current.resume())
		expect(request).not.toHaveBeenCalled()
	})
})

describe('minimalist resume control', () => {
	it('renders the owner-only idle action and an actionable rejection without changing task identity', async () => {
		request.mockResolvedValueOnce({ kind: 'rejected', reason: 'forbidden' })
		render(<WiredTaskDetails taskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Resume development' }))
		await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^Could not resume development/))
		expect(request.mock.calls[0]?.[0].sessionId).toBe('session')
	})
	it('does not render execution authority for a collaborator', () => {
		state.userId = 'collaborator'
		render(<WiredTaskDetails taskId="task" />)
		expect(screen.queryByRole('button', { name: 'Resume development' })).toBeNull()
		expect(request).not.toHaveBeenCalled()
	})
})

function StandardResume(props: Partial<ContinueSessionInputPureProps>) {
	const action = useDevelopmentResume(session, props.canManageSession ?? true)
	return (
		<ContinueSessionInputPure
			sessionId={session.id}
			sessionStatus={session.status}
			canPrompt
			canManageSession
			onSubmit={vi.fn()}
			onFocusChange={vi.fn()}
			updateSessionModel={vi.fn()}
			updateSessionEffort={vi.fn()}
			updateSessionFastMode={vi.fn()}
			multiplayerPromptingControl={<></>}
			onResumeDevelopment={() => void action.resume()}
			resumeDevelopmentPending={action.pending}
			resumeDevelopmentError={action.error}
			{...props}
		/>
	)
}

describe('standard rendered resume control', () => {
	it('uses the retained action for error, retry, pending and successful duplicate suppression', async () => {
		request.mockRejectedValueOnce(new Error('Lost response'))
		render(<StandardResume />)
		fireEvent.click(screen.getByRole('button', { name: 'Resume development' }))
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Review the task for active or queued work'),
		)
		const first = request.mock.calls[0]?.[0]
		fireEvent.click(screen.getByRole('button', { name: 'Resume development' }))
		await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
		expect(request.mock.calls[1]?.[0]).toEqual(first)
		expect(first).toMatchObject({ sessionId: session.id, executionPhase: 'implementation', intent: 'send' })
		await waitFor(() => expect(screen.getByRole('button', { name: 'Resume development' })).toBeDisabled())
		fireEvent.click(screen.getByRole('button', { name: 'Resume development' }))
		expect(request).toHaveBeenCalledTimes(2)
	})

	it.each([{ canManageSession: false }, { isDenying: true }, { isForkMode: true }])(
		'hides resume for %j',
		(props) => {
			render(<StandardResume {...props} />)
			expect(screen.queryByRole('button', { name: 'Resume development' })).toBeNull()
			expect(request).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ canPrompt: false },
		{ disabled: true },
		{ isSubmitting: true },
		{ isHostOffline: true },
		{ resumeDevelopmentPending: true },
	])('disables resume for %j', (props) => {
		render(<StandardResume {...props} />)
		const button = screen.getByRole('button', { name: 'Resume development' })
		expect(button).toBeDisabled()
		fireEvent.click(button)
		expect(request).not.toHaveBeenCalled()
	})
})

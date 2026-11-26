import type { TaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { TaskAttentionPanel } from './TaskAttentionPanel'

const { auth, setAttention } = vi.hoisted(() => ({ auth: { user: { id: 'owner' } }, setAttention: vi.fn() }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => auth }))
vi.mock('@/orpc/client', () => ({ useRiptideApi: () => ({ client: { tasks: { attention: { set: setAttention } } } }) }))

const projectDraft = {
	id: 'task',
	resource_owner_user_id: 'owner',
	archived: false,
	is_draft: true,
	project_id: 'project',
	task_attention: null,
}

beforeEach(() => {
	auth.user.id = 'owner'
	setAttention.mockReset()
})

afterEach(cleanup)

function openPanel(task: Parameters<typeof TaskAttentionPanel>[0]['task'] = projectDraft) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<TaskAttentionPanel task={task} attention={[]} delivery={null} />
		</QueryClientProvider>,
	)
}

test('lets the owner record an external wait on a project draft', async () => {
	setAttention.mockResolvedValue({ attention: null })
	openPanel()
	fireEvent.click(screen.getByRole('button', { name: 'Set attention' }))
	fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'external_wait' } })
	fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Carrier review is pending' } })
	fireEvent.change(screen.getByLabelText('Responsible'), { target: { value: 'Carrier support' } })
	fireEvent.change(screen.getByLabelText('Next action'), { target: { value: 'Confirm the counting period' } })
	fireEvent.click(screen.getByRole('button', { name: 'Save attention' }))
	await waitFor(() =>
		expect(setAttention).toHaveBeenCalledWith(
			{
				taskId: projectDraft.id,
				expected: null,
				attention: {
					kind: 'external_wait',
					reason: 'Carrier review is pending',
					responsible: 'Carrier support',
					nextAction: 'Confirm the counting period',
					evidence: undefined,
					followUpAt: undefined,
				},
			},
			{ context: { silent: true } },
		),
	)
})

test('retains resolved evidence and notice status in task detail without allowing a nonowner to edit', () => {
	auth.user.id = 'collaborator'
	const attention: TaskAttention = {
		id: '019abcde-1234-7abc-8abc-123456789abc',
		revision: 2,
		authorizedBy: 'owner',
		kind: 'external_wait',
		reason: 'Carrier review is pending',
		responsible: 'Carrier support',
		nextAction: 'Confirm the counting period',
		evidence: 'Carrier ticket 42',
		openedAt: 1,
		updatedAt: 3,
		resolvedAt: 3,
		notice: {
			id: '00000000-0000-4000-8000-000000000003',
			reservedAt: 2,
			slack: { status: 'unavailable' },
			origin: { status: 'delivered', receipt: 'origin-id' },
		},
	}
	openPanel({ ...projectDraft, task_attention: attention })
	expect(screen.getByText('Last resolved attention')).toBeInTheDocument()
	expect(screen.getByText('Carrier ticket 42')).toBeInTheDocument()
	expect(screen.getByText(/Slack alert unavailable/)).toBeInTheDocument()
	expect(screen.queryByRole('button', { name: 'Set attention' })).toBeNull()
})

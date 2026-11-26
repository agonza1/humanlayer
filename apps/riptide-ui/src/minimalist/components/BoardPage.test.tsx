import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { BoardPage } from './BoardPage'

const { useTaskTree } = vi.hoisted(() => ({
	useTaskTree: vi.fn(),
}))
vi.mock('@/minimalist/lib/data', () => ({ useTaskTree }))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/task">{children}</a>,
}))
vi.mock('@/minimalist/components/Avatar', () => ({ WiredUserAvatar: () => null }))
vi.mock('@/minimalist/components/SettingsControls', () => ({ Segmented: () => null }))
vi.mock('@/hooks/useMinuteClock', () => ({ useMinuteClock: () => Date.UTC(2026, 10, 21, 20) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ closeSidebarOnNarrow: vi.fn() }) }))
vi.mock('@/minimalist/lib/use-unread', () => ({ useTaskUnread: () => false }))

afterEach(() => {
	cleanup()
})

test('moves an unlabeled card from Todo through implementation to review as live state changes', () => {
	const row = {
		task: { id: 'canary', name: 'Canary', resource_owner_user_id: 'owner' },
		projectName: 'Repository',
		sessions: [{ archived: false, labels: null, last_activity_at: 1n, status: 'draft' }],
	}
	useTaskTree.mockReturnValue({ recent: [row], isReady: true })
	const { rerender } = render(<BoardPage />)
	expect(within(screen.getByRole('region', { name: 'To do' })).getByRole('link', { name: /Canary/ })).toBeTruthy()
	row.sessions[0].status = 'running'
	rerender(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'Implementation' })).getByRole('link', { name: /Canary.*Running/ }),
	).toBeTruthy()
	row.sessions[0].status = 'ready_for_input'
	rerender(<BoardPage />)
	const review = within(screen.getByRole('region', { name: 'In review' }))
	expect(review.getByText('Check results and pull requests')).toBeTruthy()
	expect(review.getByRole('link', { name: /Canary.*Idle/ })).toBeTruthy()
	useTaskTree.mockReturnValue({ recent: [], isReady: true })
	rerender(<BoardPage />)
	expect(screen.queryByRole('link', { name: /Canary/ })).toBeNull()
})

test('keeps idle work in review until archived data leaves the active board, without a Done column', () => {
	const row = {
		task: { id: 'merged', name: 'Merged delivery', resource_owner_user_id: 'owner' },
		projectName: 'Repository',
		sessions: [{ id: 'session', archived: false, labels: null, last_activity_at: 1n, status: 'ready_for_input' }],
	}
	useTaskTree.mockReturnValue({ recent: [row], isReady: true })
	const { rerender } = render(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'In review' })).getByRole('link', { name: /Merged delivery/ }),
	).toBeTruthy()
	expect(screen.queryByRole('region', { name: 'Done' })).toBeNull()
	expect(useTaskTree).toHaveBeenLastCalledWith(false, 'everyone')
	useTaskTree.mockReturnValue({ recent: [], isReady: true })
	rerender(<BoardPage />)
	expect(screen.queryByRole('link', { name: /Merged delivery/ })).toBeNull()
})

test('shows the local update time and includes the date for cards at least a day old', () => {
	const recent = Date.UTC(2026, 10, 21, 19, 5)
	const old = Date.UTC(2026, 10, 20, 18, 45)
	useTaskTree.mockReturnValue({
		recent: [
			{ task: { id: 'recent', name: 'Today', updated_at: BigInt(recent) }, sessions: [] },
			{ task: { id: 'old', name: 'Older', updated_at: BigInt(old) }, sessions: [] },
		],
		isReady: true,
	})
	render(<BoardPage />)

	const clock = { hour: 'numeric', minute: '2-digit' } as const
	const recentTime = screen.getByRole('link', { name: /Today/ }).querySelector('time')
	expect(recentTime?.textContent).toContain(new Intl.DateTimeFormat(undefined, clock).format(recent))
	expect(recentTime?.textContent).not.toContain(new Intl.DateTimeFormat(undefined, { month: 'short' }).format(recent))
	expect(recentTime?.dateTime).toBe(new Date(recent).toISOString())

	const oldTime = screen.getByRole('link', { name: /Older/ }).querySelector('time')
	expect(oldTime?.textContent).toContain(
		new Intl.DateTimeFormat(undefined, { ...clock, month: 'short', day: 'numeric' }).format(old),
	)
	expect(oldTime?.dateTime).toBe(new Date(old).toISOString())
})

test('filters attention across phases and shows who an external wait depends on', () => {
	useTaskTree.mockReturnValue({
		recent: [
			{ task: { id: 'draft', name: 'Routine draft' }, sessions: [] },
			{
				task: {
					id: 'sms',
					name: 'Business SMS',
					resource_owner_user_id: 'owner',
					task_attention: {
						id: '019abcde-1234-7abc-8abc-123456789abc',
						revision: 1,
						authorizedBy: 'owner',
						kind: 'external_wait',
						reason: 'Waiting for the carrier',
						responsible: 'SignalWire',
						nextAction: 'Confirm the counting window',
						openedAt: 1,
						updatedAt: 1,
						followUpAt: 2,
						notice: {
							id: '00000000-0000-4000-8000-000000000003',
							slack: { status: 'unavailable' },
							origin: { status: 'delivered', receipt: 'notice' },
							reservedAt: 3,
						},
					},
				},
				sessions: [
					{
						id: 'session',
						archived: false,
						status: 'ready_for_input',
						last_activity_at: 1n,
						labels: [{ name: 'rpi:implementation', title: 'Implementation' }],
					},
				],
			},
		],
		isReady: true,
	})
	render(<BoardPage />)
	fireEvent.click(screen.getByRole('button', { name: 'Attention (1)' }))
	expect(screen.queryByRole('link', { name: /Routine draft/ })).toBeNull()
	const card = within(screen.getByRole('region', { name: 'Implementation' })).getByRole('link', {
		name: /Business SMS/,
	})
	expect(within(card).getByText('Waiting on SignalWire')).toBeInTheDocument()
	expect(within(card).getByText('Confirm the counting window')).toBeInTheDocument()
	expect(within(card).getByText(/Follow-up due/)).toBeInTheDocument()
	expect(within(card).getByText(/Slack alert unavailable/)).toBeInTheDocument()
})

import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { BoardPage } from './BoardPage'

const { useTaskTree, useTaskDeliveries } = vi.hoisted(() => ({
	useTaskTree: vi.fn(),
	useTaskDeliveries: vi.fn<(...args: unknown[]) => Set<string>>(() => new Set<string>()),
}))
vi.mock('@/hooks/useTaskDeliveries', () => ({ useTaskDeliveries }))
vi.mock('@/minimalist/lib/data', () => ({ useTaskTree }))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/task">{children}</a>,
}))
vi.mock('@/minimalist/components/Avatar', () => ({ WiredUserAvatar: () => null }))
vi.mock('@/minimalist/components/SettingsControls', () => ({ Segmented: () => null }))
vi.mock('@/minimalist/components/TaskItem', () => ({ TaskMark: () => null }))
vi.mock('@/minimalist/lib/status', () => ({ statusText: () => null }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ closeSidebarOnNarrow: vi.fn() }) }))
vi.mock('@/minimalist/lib/use-unread', () => ({ useTaskUnread: () => false }))

afterEach(() => {
	cleanup()
	useTaskDeliveries.mockReset()
	useTaskDeliveries.mockReturnValue(new Set())
})

test('moves an unlabeled card from Todo through implementation to review as live state changes', () => {
	const row = {
		task: { id: 'canary', name: 'Canary', resource_owner_user_id: 'owner' },
		projectName: 'Repository',
		sessions: [{ archived: false, labels: null, last_activity_at: 1n, status: 'draft' }],
	}
	useTaskTree.mockReturnValue({ recent: [row], isReady: true })
	const { rerender } = render(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'Todo / Draft' })).getByRole('link', { name: /Canary/ }),
	).toBeTruthy()
	row.sessions[0].status = 'running'
	rerender(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'Implementation' })).getByRole('link', { name: /Canary/ }),
	).toBeTruthy()
	row.sessions[0].status = 'ready_for_input'
	rerender(<BoardPage />)
	expect(within(screen.getByRole('region', { name: 'In Review' })).getByRole('link', { name: /Canary/ })).toBeTruthy()
	useTaskTree.mockReturnValue({ recent: [], isReady: true })
	rerender(<BoardPage />)
	expect(screen.queryByRole('link', { name: /Canary/ })).toBeNull()
})

test('waits for complete session sync, then moves a confirmed delivery to Done', () => {
	const row = {
		task: { id: 'merged', name: 'Merged delivery', resource_owner_user_id: 'owner' },
		projectName: 'Repository',
		sessions: [{ id: 'session', archived: false, labels: null, last_activity_at: 1n, status: 'ready_for_input' }],
	}
	useTaskDeliveries.mockImplementation((...args: unknown[]) =>
		(args[0] as unknown[]).length ? new Set(['merged']) : new Set(),
	)
	useTaskTree.mockReturnValue({ recent: [row], isReady: false })
	const { rerender } = render(<BoardPage />)
	expect(useTaskDeliveries).toHaveBeenLastCalledWith([])
	expect(
		within(screen.getByRole('region', { name: 'In Review' })).getByRole('link', { name: /Merged delivery/ }),
	).toBeTruthy()
	useTaskTree.mockReturnValue({ recent: [row], isReady: true })
	rerender(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'Done' })).getByRole('link', { name: /Merged delivery/ }),
	).toBeTruthy()
	row.sessions[0].status = 'running'
	rerender(<BoardPage />)
	expect(
		within(screen.getByRole('region', { name: 'Implementation' })).getByRole('link', { name: /Merged delivery/ }),
	).toBeTruthy()
})

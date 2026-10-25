import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullRequestPanel } from './PullRequestPanel'
import { PullRequestsPage } from './PullRequestsPage'

const { data, stream, mutate } = vi.hoisted(() => ({
	data: { task: null as unknown, branches: [] as unknown[], failed: false, recent: [] as unknown[] },
	stream: vi.fn(() => ({ pullRequest: null, checks: [] })),
	mutate: vi.fn(),
}))
vi.mock('@tanstack/react-db', async (original) => ({
	...(await original<typeof import('@tanstack/react-db')>()),
	useLiveQuery: () => ({ data: data.task ? [data.task] : [], isReady: true }),
}))
vi.mock('@/components/providers/SyncProvider', () => ({ useSync: () => ({ tasksCollection: {} }) }))
vi.mock('@/minimalist/lib/data', () => ({ useTaskTree: () => ({ recent: data.recent, isReady: true }) }))
vi.mock('@/orpc/client', () => ({
	useRiptideApi: () => ({
		client: { integrations: { github: { pullRequests: { mutate } } } },
		queryClient: {
			integrations: {
				github: {
					pullRequests: {
						listPullRequestBranches: {
							queryOptions: ({ input }: { input: { taskId: string } }) => ({
								queryKey: ['branches', input.taskId],
								queryFn: async () => {
									if (data.failed) throw new Error('GitHub unavailable')
									return { branches: data.branches }
								},
							}),
						},
					},
				},
			},
		},
	}),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="#task">{children}</a>,
}))
vi.mock('@/hooks/session-detail/usePrStatusStream', () => ({ usePrStatusStream: stream }))
vi.mock('@/minimalist/lib/use-action', () => ({ useAction: () => ({ pending: false, run: vi.fn() }) }))
vi.mock('@/minimalist/lib/send', () => ({ useAskAgent: () => ({ pending: false, ask: vi.fn() }), askToast: vi.fn() }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast: vi.fn() }) }))

const task = {
	id: 'task',
	name: 'Clarify Sidea test setup',
	delivery_result: {
		status: 'merged',
		pullRequestUrl: 'https://github.com/agonza1/Sidea-pro/pull/15',
		headSha: 'a'.repeat(40),
	},
}
function view(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}
beforeEach(() => {
	data.task = task
	data.recent = [{ task, lastActivity: Date.now(), latest: null }]
	data.branches = []
	data.failed = false
	stream.mockClear()
	mutate.mockClear()
})
afterEach(cleanup)

describe('delivered pull request visibility', () => {
	it.each(['empty', 'uninstalled', 'error'])(
		'task panel shows a merged read-only link with native %s',
		async (state) => {
			if (state === 'uninstalled') data.branches = [{ installed: false, pullRequest: null }]
			if (state === 'error') data.failed = true
			view(<PullRequestPanel taskId="task" sessionId="coder" />)
			expect(await screen.findByRole('link', { name: /agonza1\/Sidea-pro #15/ })).toHaveAttribute(
				'href',
				task.delivery_result.pullRequestUrl,
			)
			expect(screen.getByText('Merged')).toBeVisible()
			expect(screen.getByText(task.delivery_result.headSha)).toBeVisible()
			expect(screen.queryByRole('button', { name: /open one|merge|ready for review/i })).toBeNull()
			expect(screen.queryByText('No pull request yet')).toBeNull()
			expect(stream).not.toHaveBeenCalled()
			expect(mutate).not.toHaveBeenCalled()
		},
	)
	it.each(['empty', 'uninstalled', 'error', 'stale open'])(
		'global inbox includes merged receipt under All with native %s',
		async (state) => {
			if (state === 'uninstalled') data.branches = [{ installed: false, pullRequest: null }]
			if (state === 'error') data.failed = true
			if (state === 'stale open')
				data.branches = [
					{
						installed: true,
						repoFullName: 'agonza1/sidea-pro',
						branch: 'feature',
						pullRequest: {
							id: 'native',
							url: task.delivery_result.pullRequestUrl.toLowerCase(),
							state: 'open',
							title: 'Stale open snapshot',
							isDraft: false,
						},
					},
				]
			view(<PullRequestsPage />)
			fireEvent.click(await screen.findByRole('button', { name: 'Show 1 merged or closed PR' }))
			expect(await screen.findByRole('link', { name: /agonza1\/Sidea-pro #15/ })).toHaveAttribute(
				'href',
				task.delivery_result.pullRequestUrl,
			)
			expect(screen.getByText('Merged')).toBeVisible()
			expect(screen.queryByText('Stale open snapshot')).toBeNull()
			expect(screen.queryByText('Could not load pull requests')).toBeNull()
			expect(stream).not.toHaveBeenCalled()
			fireEvent.click(screen.getByRole('radio', { name: 'Open' }))
			expect(screen.queryByRole('link', { name: /agonza1\/Sidea-pro #15/ })).toBeNull()
			expect(screen.getByText('No open pull requests')).toBeVisible()
		},
	)
	it('deduplicates a matching native merged PR and retains its richer detail', async () => {
		data.branches = [
			{
				installed: true,
				repoFullName: 'agonza1/sidea-pro',
				branch: 'feature',
				pullRequest: {
					id: 'native',
					url: task.delivery_result.pullRequestUrl.toLowerCase(),
					state: 'merged',
					title: 'Actual GitHub title',
					isDraft: false,
					number: 15,
					baseRef: 'main',
					headRef: 'feature',
				},
			},
		]
		view(<PullRequestsPage />)
		fireEvent.click(await screen.findByRole('button', { name: 'Show 1 merged or closed PR' }))
		expect(await screen.findByRole('link', { name: /agonza1\/sidea-pro #15/ })).toBeVisible()
		expect(screen.getAllByRole('button', { name: /Actual GitHub title/ })).toHaveLength(1)
		expect(screen.getByText('Checks')).toBeVisible()
		expect(stream).toHaveBeenCalled()
	})
	it('malformed or missing receipts retain the native empty and error states', async () => {
		data.task = { ...task, delivery_result: { status: 'merged' } }
		view(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(await screen.findByText('No pull request yet')).toBeVisible()
		expect(screen.getByRole('button', { name: 'Ask the agent to open one' })).toBeVisible()
		cleanup()
		data.task = { id: 'task', name: 'Task' }
		data.failed = true
		view(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(await screen.findByText('Could not load the pull request')).toBeVisible()
		expect(stream).not.toHaveBeenCalled()
	})
})

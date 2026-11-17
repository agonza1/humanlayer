import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullRequestDetail, PullRequestPanel } from './PullRequestPanel'

vi.mock('@/orpc/client', () => ({ useRiptideApi: () => ({ client: {} }) }))
const { liveStatus, taskPr } = vi.hoisted(() => ({ liveStatus: vi.fn(), taskPr: vi.fn() }))
vi.mock('@/hooks/session-detail/usePrStatusStream', () => ({ usePrStatusStream: liveStatus }))
vi.mock('@/minimalist/lib/pull-requests', () => ({ useTaskPullRequest: taskPr }))
beforeEach(() => {
	liveStatus.mockReturnValue({ pullRequest: null, checks: [], status: 'ready' })
	taskPr.mockReturnValue({ branch: { repoFullName: 'acme/app', branch: 'feature', pullRequest: null } })
})
vi.mock('@/minimalist/lib/use-action', () => ({ useAction: () => ({ pending: false, run: vi.fn() }) }))
vi.mock('@/minimalist/lib/send', () => ({
	useAskAgent: () => ({ pending: false, ask: vi.fn() }),
	askToast: vi.fn(),
}))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast: vi.fn() }) }))

afterEach(cleanup)

type Props = Parameters<typeof PullRequestDetail>[0]

const pullRequest = {
	number: 42,
	url: 'https://github.com/acme/app/pull/42',
	title: 'Add the thing',
	state: 'open',
	isDraft: false,
	baseRef: 'main',
	headRef: 'feature',
	reviewDecision: null,
	changesRequestedReviews: [],
	merge: null,
} as unknown as Props['pullRequest']

describe('PullRequestDetail', () => {
	it('copies the pull request link from beside the link out', async () => {
		const writeText = vi.fn(async () => {})
		Object.assign(navigator, { clipboard: { writeText } })
		render(
			<PullRequestDetail
				taskId="task"
				sessionId={null}
				branch={{ repoFullName: 'acme/app', branch: 'feature', pullRequest } as unknown as Props['branch']}
				pullRequest={pullRequest}
			/>,
		)
		expect(screen.getByRole('link', { name: /acme\/app #42/ }).getAttribute('href')).toBe(pullRequest.url)
		fireEvent.click(screen.getByRole('button', { name: 'Copy pull request link' }))
		await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://github.com/acme/app/pull/42'))
	})
})

describe('PullRequestPanel discovery', () => {
	it('discovers a merged PR when the branch has no cached PR', () => {
		liveStatus.mockReturnValue({ pullRequest: { ...pullRequest, state: 'merged' }, checks: [], status: 'ready' })
		render(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(liveStatus).toHaveBeenCalledWith({
			scope: { taskId: 'task' },
			repoFullName: 'acme/app',
			branch: 'feature',
		})
		expect(screen.getByRole('link', { name: /acme\/app #42/ }).getAttribute('href')).toBe(pullRequest.url)
		expect(screen.getByText('Merged')).toBeTruthy()
		expect(screen.queryByText('No pull request yet')).toBeNull()
	})
	it('does not report no PR while GitHub is still loading', () => {
		liveStatus.mockReturnValue({ pullRequest: null, checks: [], status: 'hydrating' })
		render(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(screen.queryByText('No pull request yet')).toBeNull()
	})
	it('distinguishes an unavailable GitHub response from an absent PR', () => {
		liveStatus.mockReturnValue({ pullRequest: null, checks: [], status: 'unavailable' })
		render(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(screen.getByRole('alert').textContent).toContain('Could not load the pull request')
		expect(screen.queryByText('No pull request yet')).toBeNull()
	})
	it('shows the empty state only after GitHub confirms no PR', () => {
		render(<PullRequestPanel taskId="task" sessionId={null} />)
		expect(screen.getByText('No pull request yet')).toBeTruthy()
	})
})

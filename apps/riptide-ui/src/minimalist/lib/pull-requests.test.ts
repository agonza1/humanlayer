import { describe, expect, it } from 'vitest'

import { deliveredPullRequest, selectTaskPullRequest, pullRequestBadge } from '@/minimalist/lib/pull-requests'

const open = { state: 'open', isDraft: false, reviewDecision: null }
const checks = (failed = 0, running = 0, passed = 0) => ({
	failed: Array.from({ length: failed }),
	running: Array.from({ length: running }),
	passed: Array.from({ length: passed }),
})

describe('pullRequestBadge', () => {
	it('puts merged and closed before checks', () => {
		expect(pullRequestBadge({ ...open, state: 'merged' }, checks(2))).toEqual({ label: 'Merged', tone: 'muted' })
		expect(pullRequestBadge({ ...open, state: 'closed' }, checks(2))).toEqual({ label: 'Closed', tone: 'muted' })
	})

	it('counts failing checks first, then running ones', () => {
		expect(pullRequestBadge(open, checks(2, 1, 5))).toEqual({ label: '2 failing', tone: 'del' })
		expect(pullRequestBadge(open, checks(0, 3, 5))).toEqual({ label: '3 running', tone: 'muted' })
	})

	it('falls back to reviews, draft and passing checks', () => {
		expect(pullRequestBadge({ ...open, reviewDecision: 'CHANGES_REQUESTED' }, checks(0, 0, 1)).label).toBe(
			'Changes requested',
		)
		expect(pullRequestBadge({ ...open, isDraft: true }, checks(0, 0, 1)).label).toBe('Draft')
		expect(pullRequestBadge({ ...open, reviewDecision: 'APPROVED' }, checks(0, 0, 1)).label).toBe('Approved')
		expect(pullRequestBadge(open, checks(0, 0, 1))).toEqual({ label: 'Checks pass', tone: 'add' })
		expect(pullRequestBadge(open, checks())).toEqual({ label: 'Open', tone: 'muted' })
	})
})

describe('delivered pull requests', () => {
	const task = {
		name: 'Sidea task',
		delivery_result: {
			status: 'merged',
			pullRequestUrl: 'https://github.com/owner/Repo/pull/15',
			headSha: 'a'.repeat(40),
		},
	}
	it('projects only validated durable outcomes without inventing a branch or checks', () => {
		expect(deliveredPullRequest(task)).toMatchObject({
			number: 15,
			repoFullName: 'owner/Repo',
			state: 'merged',
			headSha: 'a'.repeat(40),
		})
		expect(deliveredPullRequest({ name: 'Task' })).toBeNull()
		expect(
			deliveredPullRequest({
				...task,
				delivery_result: { status: 'merged', pullRequestUrl: 'javascript:alert(1)' },
			}),
		).toBeNull()
	})
	it('retains delivery without native branches or an installed integration', () => {
		expect(selectTaskPullRequest(task, []).delivered?.number).toBe(15)
		expect(selectTaskPullRequest(task, [{ installed: false } as never]).branch).toBeNull()
	})
	it('uses matching native merged metadata case-insensitively but ignores stale open metadata', () => {
		const branch = {
			installed: true,
			isCurrent: true,
			pullRequest: { url: 'https://github.com/owner/repo/pull/15', state: 'merged' },
		} as never
		expect(selectTaskPullRequest(task, [branch]).delivered).toBeNull()
		expect(selectTaskPullRequest(task, [branch]).branch).toBe(branch)
		const stale = {
			...(branch as object),
			pullRequest: { url: task.delivery_result.pullRequestUrl, state: 'open' },
		} as never
		expect(selectTaskPullRequest(task, [stale]).delivered?.state).toBe('merged')
	})
})

import type { PullRequestBranch } from '@humanlayer/riptide-api-contract/api/integrations/github/pull-requests/list-branches'
import { describe, expect, test } from 'vitest'

import {
	canCheckTaskDelivery,
	fetchTaskDelivery,
	isFreshTaskDelivery,
	type FreshBranchDelivery,
	isTaskDeliveryComplete,
	type TaskDeliveryInput,
	taskDeliveryRevision,
} from './taskDelivery'

const mergedAt = '2026-11-16T12:00:00Z'
const beforeMerge = BigInt(Date.parse(mergedAt) - 1)
const task = (): TaskDeliveryInput => ({
	id: 'task',
	is_draft: false,
	sessions: [{ id: 'session', archived: false, status: 'ready_for_input', last_activity_at: beforeMerge }],
})
const branch = (repoFullName = 'owner/repo'): PullRequestBranch => ({
	repoFullName,
	branch: 'feature',
	isCurrent: true,
	installed: true,
	sessionIds: ['session'],
	pullRequest: {
		id: 'pr',
		number: 12,
		title: 'Delivery',
		url: 'https://github.com/owner/repo/pull/12',
		state: 'merged',
		isDraft: false,
		headRef: 'feature',
		baseRef: 'main',
		headSha: 'tested-sha',
		mergeable: null,
		reviewDecision: null,
		unresolvedThreadCount: null,
		resolvedThreadCount: null,
		changesRequestedReviews: null,
		merge: null,
	},
})
const fresh = (repoFullName = 'owner/repo'): FreshBranchDelivery => ({
	repoFullName,
	branch: 'feature',
	delivery: { number: 12, state: 'merged', headSha: 'tested-sha', branchHeadSha: 'tested-sha', mergedAt },
})
const complete = (t = task(), branches = [branch()], deliveries = [fresh()]) =>
	isTaskDeliveryComplete(t, branches, deliveries)

describe('merged task delivery', () => {
	test('completes an idle task only after a fresh exact-branch merge confirmation', () => {
		expect(complete()).toBe(true)
		const deletedBranch = fresh()
		deletedBranch.delivery!.branchHeadSha = null
		expect(complete(task(), [branch()], [deletedBranch])).toBe(true)
	})

	test('requires every tracked repository branch, not the first merged PR', () => {
		expect(complete(task(), [branch(), branch('owner/second')], [fresh()])).toBe(false)
		expect(complete(task(), [branch(), branch('owner/second')], [fresh(), fresh('owner/second')])).toBe(true)
		const second = fresh('owner/second')
		second.delivery!.state = 'open'
		expect(complete(task(), [branch(), branch('owner/second')], [fresh(), second])).toBe(false)
	})

	test('supports sequential merges from independent repository sessions', () => {
		const t = task()
		const laterMerge = Date.parse(mergedAt) + 900_000
		t.sessions.push({
			id: 'session-b',
			archived: false,
			status: 'ready_for_input',
			last_activity_at: BigInt(laterMerge - 1),
		})
		const secondBranch = { ...branch('owner/second'), sessionIds: ['session-b'] }
		const secondFresh = fresh('owner/second')
		secondFresh.delivery!.mergedAt = new Date(laterMerge).toISOString()
		expect(complete(t, [branch(), secondBranch], [fresh(), secondFresh])).toBe(true)
		t.sessions[0].last_activity_at = beforeMerge + 2n
		expect(complete(t, [branch(), secondBranch], [fresh(), secondFresh])).toBe(false)
	})

	test('rejects duplicate, wrong repository and wrong branch confirmations', () => {
		expect(complete(task(), [branch(), branch('owner/second')], [fresh(), fresh()])).toBe(false)
		expect(complete(task(), [branch()], [fresh('owner/other')])).toBe(false)
		expect(complete(task(), [branch()], [{ ...fresh(), branch: 'other' }])).toBe(false)
	})

	test('does not infer delivery from no PR, no installation, an old API, or missing timestamps', () => {
		expect(complete(task(), [], [])).toBe(false)
		expect(complete(task(), [{ ...branch(), installed: false }])).toBe(false)
		expect(complete(task(), [{ ...branch(), pullRequest: null }])).toBe(false)
		expect(complete(task(), [branch()], [{ ...fresh(), delivery: undefined }])).toBe(false)
		for (const value of [null, 'invalid']) {
			const response = fresh()
			response.delivery!.mergedAt = value
			expect(complete(task(), [branch()], [response])).toBe(false)
		}
	})

	test.each(['open', 'closed'] as const)('does not complete a freshly %s PR', (state) => {
		const response = fresh()
		response.delivery!.state = state
		expect(complete(task(), [branch()], [response])).toBe(false)
	})

	test('rejects a stale recorded PR number/head and a branch reused after merge', () => {
		for (const change of [
			{ number: 13 },
			{ headSha: 'different' },
			{ branchHeadSha: 'new-commit' },
			{ headSha: '' },
		]) {
			const response = fresh()
			Object.assign(response.delivery!, change)
			expect(complete(task(), [branch()], [response])).toBe(false)
		}
	})

	test('an earlier still-open PR prevents a merged sibling from completing the task', () => {
		const row = branch()
		row.earlierPullRequests = [{ ...row.pullRequest!, number: 11, state: 'open' }]
		expect(complete(task(), [row])).toBe(false)
		row.earlierPullRequests[0].state = 'closed'
		expect(complete(task(), [row])).toBe(true)
	})

	test.each(['running', 'needs_approval', 'failed', 'lost', 'draft', null])(
		'active or uncertain %s work overrides an old merge',
		(status) => {
			const t = task()
			t.sessions.push({ id: 'second', archived: false, status, last_activity_at: beforeMerge })
			expect(complete(t)).toBe(false)
		},
	)

	test('resumed activity after merge and unknown activity remain unfinished', () => {
		for (const activity of [beforeMerge + 2n, null]) {
			const t = task()
			t.sessions[0].last_activity_at = activity
			expect(complete(t)).toBe(false)
		}
		expect(complete({ ...task(), is_draft: true })).toBe(false)
		expect(canCheckTaskDelivery({ ...task(), sessions: [] })).toBe(false)
	})

	test('invalidates in-flight answers when work resumes, while archived history stays harmless', () => {
		const t = task()
		const revision = taskDeliveryRevision(t)
		t.sessions[0].status = 'running'
		expect(taskDeliveryRevision(t)).not.toBe(revision)
		t.sessions[0].status = 'ready_for_input'
		t.sessions[0].last_activity_at = beforeMerge + 2n
		expect(taskDeliveryRevision(t)).not.toBe(revision)
		t.sessions[0].last_activity_at = beforeMerge
		t.sessions.push({ id: 'old', archived: true, status: 'failed', last_activity_at: beforeMerge + 2n })
		expect(complete(t)).toBe(true)
	})
})

describe('stock delivery reader', () => {
	test('discovers a missing recorded PR and refreshes each exact task/repository/branch', async () => {
		let reads = 0
		const calls: unknown[] = []
		const result = await fetchTaskDelivery(task(), {
			list: async (input) => {
				calls.push(input)
				return { branches: [{ ...branch(), pullRequest: reads++ === 0 ? null : branch().pullRequest }] }
			},
			refresh: async (input) => {
				calls.push(input)
				return fresh()
			},
		})
		expect(result).toBe(true)
		expect(calls).toEqual([
			{ taskId: 'task' },
			{ taskId: 'task', repoFullName: 'owner/repo', branch: 'feature' },
			{ taskId: 'task' },
		])
	})

	test('a newly observed unmerged branch during refresh prevents completion', async () => {
		let reads = 0
		expect(
			await fetchTaskDelivery(task(), {
				list: async () => ({ branches: reads++ === 0 ? [branch()] : [branch(), branch('owner/second')] }),
				refresh: async () => fresh(),
			}),
		).toBe(false)
	})

	test('propagates failed GitHub reads rather than returning cached completion', async () => {
		await expect(
			fetchTaskDelivery(task(), {
				list: async () => ({ branches: [branch()] }),
				refresh: async () => {
					throw new Error('unavailable')
				},
			}),
		).rejects.toThrow('unavailable')
	})

	test('only a recent successful read can place Done', () => {
		expect(isFreshTaskDelivery({ isSuccess: true, data: true, dataUpdatedAt: 100_000 }, 120_000)).toBe(true)
		expect(isFreshTaskDelivery({ isSuccess: false, data: true, dataUpdatedAt: 100_000 }, 120_000)).toBe(false)
		expect(isFreshTaskDelivery({ isSuccess: true, data: true, dataUpdatedAt: 100_000 }, 160_001)).toBe(false)
	})
})

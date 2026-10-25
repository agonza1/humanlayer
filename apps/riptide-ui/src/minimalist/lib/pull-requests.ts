import { TaskDeliveryResultSchema } from '@humanlayer/db/zodschemas/task-delivery-result'
import type { PullRequestBranch } from '@humanlayer/riptide-api-contract/api/integrations/github/pull-requests/list-branches'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { useQuery } from '@tanstack/react-query'

import type { CheckGroups } from '@/components/github/check-groups'
import { useSync } from '@/components/providers/SyncProvider'
import { useRiptideApi } from '@/orpc/client'

type RiptideQueryClient = ReturnType<typeof useRiptideApi>['queryClient']

/** The task's branches and their PRs. The panel and the PR inbox share one cache entry per task. */
export function pullRequestBranchesQuery(orpc: RiptideQueryClient, taskId: string) {
	return {
		...orpc.integrations.github.pullRequests.listPullRequestBranches.queryOptions({
			input: { taskId },
			context: { silent: true },
		}),
		retry: false,
		staleTime: 30_000,
	}
}

export interface DeliveredPullRequest {
	id: string
	url: string
	title: string
	repoFullName: string
	number: number
	state: 'merged'
	isDraft: false
	headSha: string
}

/** A confirmed host delivery is visible even without a GitHub App installation. */
export function deliveredPullRequest(
	task: { name: string; delivery_result?: unknown } | null | undefined,
): DeliveredPullRequest | null {
	const result = TaskDeliveryResultSchema.safeParse(task?.delivery_result)
	if (!result.success || !task) return null
	const parts = new URL(result.data.pullRequestUrl).pathname.split('/')
	const number = Number(parts[4])
	if (!Number.isSafeInteger(number)) return null
	return {
		id: `delivery:${result.data.pullRequestUrl}`,
		url: result.data.pullRequestUrl,
		title: task.name,
		repoFullName: `${parts[1]}/${parts[2]}`,
		number,
		state: 'merged',
		isDraft: false,
		headSha: result.data.headSha,
	}
}

/** GitHub repository paths are case-insensitive. */
export function samePullRequestUrl(a: string, b: string) {
	return a.toLowerCase() === b.toLowerCase()
}

/** Prefer the richer installed integration for the same PR, without fabricating a branch. */
export function selectTaskPullRequest(task: Parameters<typeof deliveredPullRequest>[0], input: PullRequestBranch[]) {
	const branches = input.filter((branch) => branch.installed)
	const delivered = deliveredPullRequest(task)
	const matching = delivered
		? branches.find(
				(branch) =>
					branch.pullRequest?.state === 'merged' && samePullRequestUrl(branch.pullRequest.url, delivered.url),
			)
		: null
	const withPr = branches.filter((branch) => branch.pullRequest)
	const branch =
		matching ??
		withPr.find((entry) => entry.isCurrent) ??
		withPr[0] ??
		branches.find((entry) => entry.isCurrent) ??
		null
	return { branch, delivered: matching ? null : delivered }
}

/**
 * The branch the task's PR lives on: the current branch with a PR first, then any branch with one.
 * `failed` means GitHub couldn't be asked, which is not the same as no PR; `retry` asks again.
 */
export function useTaskPullRequest(taskId: string) {
	const { tasksCollection } = useSync()
	const taskQuery = useLiveQuery(
		(q) => q.from({ tasks: tasksCollection }).where(({ tasks }) => eq(tasks.id, taskId)),
		[tasksCollection, taskId],
	)
	const { queryClient } = useRiptideApi()
	const { data, isLoading, isError, isFetching, refetch } = useQuery({
		...pullRequestBranchesQuery(queryClient, taskId),
		refetchOnWindowFocus: true,
	})
	const selection = selectTaskPullRequest(taskQuery.data?.[0], data?.branches ?? [])
	return {
		...selection,
		isLoading: isLoading && !selection.delivered,
		failed: isError && !data && !selection.delivered,
		retrying: isFetching,
		retry: () => void refetch(),
	}
}

export type PullRequestBadge = { label: string; tone: 'add' | 'del' | 'muted' }

/**
 * The one thing worth knowing about a PR at a glance, most urgent first:
 * closed or merged, then failing checks, running checks, requested changes, draft, approval, passing checks.
 */
export function pullRequestBadge(
	pr: { state: string; isDraft: boolean; reviewDecision?: string | null },
	checks: Pick<CheckGroups, 'failed' | 'running' | 'passed'>,
): PullRequestBadge {
	if (pr.state === 'merged') return { label: 'Merged', tone: 'muted' }
	if (pr.state === 'closed') return { label: 'Closed', tone: 'muted' }
	if (checks.failed.length > 0) return { label: `${checks.failed.length} failing`, tone: 'del' }
	if (checks.running.length > 0) return { label: `${checks.running.length} running`, tone: 'muted' }
	if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes requested', tone: 'del' }
	if (pr.isDraft) return { label: 'Draft', tone: 'muted' }
	if (pr.reviewDecision === 'APPROVED') return { label: 'Approved', tone: 'add' }
	if (checks.passed.length > 0) return { label: 'Checks pass', tone: 'add' }
	return { label: 'Open', tone: 'muted' }
}

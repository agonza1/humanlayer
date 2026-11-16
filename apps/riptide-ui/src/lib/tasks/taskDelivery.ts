import type { PullRequestBranch } from '@humanlayer/riptide-api-contract/api/integrations/github/pull-requests/list-branches'

export interface DeliverySession {
	id?: string
	archived: boolean
	status?: string | null
	last_activity_at: bigint | null
}

export interface TaskDeliveryInput {
	id: string
	is_draft?: boolean
	sessions: DeliverySession[]
}

export interface FreshBranchDelivery {
	repoFullName: string
	branch: string
	delivery?: {
		number: number
		state: 'open' | 'closed' | 'merged'
		headSha: string
		branchHeadSha: string | null
		mergedAt: string | null
	} | null
}

/** A new turn, session, or status must invalidate an in-flight completion answer. */
export function taskDeliveryRevision(task: TaskDeliveryInput): string {
	return JSON.stringify([
		task.id,
		task.is_draft,
		task.sessions
			.map((session) => [session.id, session.archived, session.status, session.last_activity_at?.toString()])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	])
}

/** Only idle, launched tasks need GitHub completion checks. No session is launched by this read. */
export function canCheckTaskDelivery(task: TaskDeliveryInput): boolean {
	if (task.is_draft) return false
	const sessions = task.sessions.filter((session) => !session.archived)
	return (
		sessions.some((session) => session.status === 'ready_for_input') &&
		sessions.every((session) => session.status === 'ready_for_input')
	)
}

const key = (branch: { repoFullName: string; branch: string }) =>
	JSON.stringify([branch.repoFullName.toLowerCase(), branch.branch])

/**
 * Done means every tracked branch was freshly confirmed merged. Historical open PRs,
 * unsupported APIs, inaccessible repositories and work after a merge remain unfinished.
 */
export function isTaskDeliveryComplete(
	task: TaskDeliveryInput,
	branches: readonly PullRequestBranch[],
	fresh: readonly FreshBranchDelivery[],
): boolean {
	if (!canCheckTaskDelivery(task) || branches.length === 0 || branches.length !== fresh.length) return false
	const byBranch = new Map(fresh.map((branch) => [key(branch), branch]))
	if (byBranch.size !== branches.length) return false
	const sessions = task.sessions.filter((session) => !session.archived)
	for (const branch of branches) {
		if (!branch.installed || !branch.pullRequest) return false
		if (branch.earlierPullRequests?.some((pr) => pr.state === 'open')) return false
		const delivery = byBranch.get(key(branch))?.delivery
		if (!delivery || delivery.state !== 'merged' || !delivery.mergedAt || !delivery.headSha) return false
		if (delivery.number !== branch.pullRequest.number || delivery.headSha !== branch.pullRequest.headSha)
			return false
		if (delivery.branchHeadSha !== null && delivery.branchHeadSha !== delivery.headSha) return false
		const mergedAt = Date.parse(delivery.mergedAt)
		if (!Number.isFinite(mergedAt)) return false
		// Independent repository sessions can finish and merge at different times.
		const branchSessions = sessions.filter((session) => !session.id || branch.sessionIds.includes(session.id))
		const unattributedSessions = sessions.filter((session) => {
			const sessionId = session.id
			return !sessionId || !branches.some((candidate) => candidate.sessionIds.includes(sessionId))
		})
		if (
			[...branchSessions, ...unattributedSessions].some(
				(session) => session.last_activity_at === null || session.last_activity_at > BigInt(mergedAt),
			)
		)
			return false
	}
	return true
}

export const TASK_DELIVERY_POLL_MS = 30_000

export interface TaskDeliveryReader {
	list: (input: { taskId: string }) => Promise<{ branches: PullRequestBranch[] }>
	refresh: (input: { taskId: string; repoFullName: string; branch: string }) => Promise<FreshBranchDelivery>
}

/** Discover missing PR records through the existing reader, then re-read persisted attribution. */
export async function fetchTaskDelivery(task: TaskDeliveryInput, reader: TaskDeliveryReader): Promise<boolean> {
	const { branches } = await reader.list({ taskId: task.id })
	if (branches.length === 0 || branches.some((branch) => !branch.installed)) return false
	const fresh: FreshBranchDelivery[] = []
	for (const branch of branches) {
		fresh.push(await reader.refresh({ taskId: task.id, repoFullName: branch.repoFullName, branch: branch.branch }))
	}
	const updated = await reader.list({ taskId: task.id })
	return isTaskDeliveryComplete(task, updated.branches, fresh)
}

/** A failed refresh or an old cache entry cannot complete a card on remount or focus. */
export function isFreshTaskDelivery(
	result: { isSuccess: boolean; data?: boolean; dataUpdatedAt: number },
	now = Date.now(),
): boolean {
	return result.isSuccess && result.data === true && now - result.dataUpdatedAt <= TASK_DELIVERY_POLL_MS * 2
}

import {
	describeBoardTask,
	hasDueFollowUp,
	type BoardTaskInput,
	type BoardSessionInput,
} from '@humanlayer/schemas/task-board'
import { decodeTaskAttention } from '@humanlayer/schemas/zod/task-attention'
import { inArray, useLiveQuery } from '@tanstack/react-db'

import { useSync } from '@/components/providers/SyncProvider'
import { useMinuteClock } from '@/hooks/useMinuteClock'

export function useBoardHosts(tasks: readonly BoardTaskInput[], nowMs: number) {
	const { onlineHostsCollection: hosts } = useSync()
	const dueOwners = new Set<string>()
	for (const task of tasks) {
		if (!task.task_attention) continue
		const attention = decodeTaskAttention(task.task_attention)
		if (attention && attention.authorizedBy === task.resource_owner_user_id && hasDueFollowUp(attention, nowMs))
			dueOwners.add(attention.authorizedBy)
	}
	const owners = [...dueOwners].sort()
	const { data } = useLiveQuery(
		(q) =>
			owners.length
				? q
						.from({ hosts })
						.where(({ hosts }) => inArray(hosts.user_id, owners))
						.select(({ hosts }) => ({
							host_id: hosts.host_id,
							organization_id: hosts.organization_id,
							user_id: hosts.user_id,
							status: hosts.status,
							last_seen: hosts.last_seen,
						}))
				: undefined,
		[hosts, owners.join('\0')],
	)
	return data
}

export function useBoardTask(task: BoardTaskInput | null | undefined, sessions: readonly BoardSessionInput[]) {
	const now = useMinuteClock()
	const hosts = useBoardHosts(task ? [task] : [], now)
	return task ? describeBoardTask(task, sessions, hosts, now) : null
}

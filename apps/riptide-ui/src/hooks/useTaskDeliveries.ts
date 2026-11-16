import { useQueries } from '@tanstack/react-query'

import {
	canCheckTaskDelivery,
	fetchTaskDelivery,
	isFreshTaskDelivery,
	TASK_DELIVERY_POLL_MS,
	taskDeliveryRevision,
	type TaskDeliveryInput,
} from '@/lib/tasks/taskDelivery'
import { useRiptideApi } from '@/orpc/client'

/** Reuse the stock GitHub read/stream endpoint; no worker, task mutation, or scheduler. */
export function useTaskDeliveries(tasks: TaskDeliveryInput[]): ReadonlySet<string> {
	const { client, authScope } = useRiptideApi()
	const candidates = tasks.filter(canCheckTaskDelivery)
	const results = useQueries({
		queries: candidates.map((task) => ({
			queryKey: ['task-delivery', authScope, taskDeliveryRevision(task)],
			queryFn: ({ signal }) => {
				const options = {
					context: { silent: true },
					signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
				}
				return fetchTaskDelivery(task, {
					list: (input) => client.integrations.github.pullRequests.listPullRequestBranches(input, options),
					refresh: (input) => client.integrations.github.pullRequests.ensureStream(input, options),
				})
			},
			staleTime: TASK_DELIVERY_POLL_MS,
			refetchInterval: TASK_DELIVERY_POLL_MS,
			refetchOnWindowFocus: true,
			retry: false,
		})),
	})
	return new Set(
		candidates
			.filter((_task, index) => {
				const result = results[index]
				return result !== undefined && isFreshTaskDelivery(result)
			})
			.map((task) => task.id),
	)
}

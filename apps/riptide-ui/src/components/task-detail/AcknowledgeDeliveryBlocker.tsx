import { Button } from '@humanlayer/ui/components/button'
import { useMutation } from '@tanstack/react-query'

import { useBrowserAuth } from '@/hooks/use-browser-auth'
import { useRiptideApi } from '@/orpc/client'

export function AcknowledgeDeliveryBlocker({
	taskId,
	ownerId,
	alertId,
	acknowledgedAt,
}: {
	taskId: string
	ownerId: string | null | undefined
	alertId: string
	acknowledgedAt?: number
}) {
	const { user } = useBrowserAuth()
	const { client } = useRiptideApi()
	const acknowledgement = useMutation({
		mutationFn: () => client.tasks.delivery.acknowledgeBlocker({ taskId, alertId }),
	})
	if (!ownerId || user?.id !== ownerId) return null
	if (acknowledgedAt !== undefined || acknowledgement.data?.acknowledged) return <p>Reminder acknowledged.</p>
	return (
		<div className="mt-1">
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={acknowledgement.isPending}
				onClick={() => acknowledgement.mutate()}
			>
				Acknowledge blocker
			</Button>
			{acknowledgement.isError && <p>Could not acknowledge this blocker. Try again.</p>}
			{acknowledgement.data?.acknowledged === false && (
				<p>The blocker changed. Refresh the task before trying again.</p>
			)}
		</div>
	)
}

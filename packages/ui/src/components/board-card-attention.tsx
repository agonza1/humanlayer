import type { BoardAttention, BoardDelivery } from '@humanlayer/schemas/task-board'
import { boardAttentionFollowUpLabel, boardAttentionGapLabel, boardAttentionLabel, boardDeliveryAlertLabel } from '../lib/task-board'

export function BoardCardAttention({ item, delivery, nowMs }: {
	item?: BoardAttention
	delivery?: BoardDelivery | null
	nowMs: number
}) {
	if (!item || item.kind === 'blocked') return delivery?.status === 'blocked' && (
		<span className="block break-words text-xs">{delivery.reason}<br />{boardDeliveryAlertLabel(delivery)}</span>
	)
	const followUp = boardAttentionFollowUpLabel(item, nowMs)
	const gap = boardAttentionGapLabel(item.alert)
	return (
		<span className="block space-y-1 break-words text-xs">
			<strong className="block">{boardAttentionLabel(item)}</strong>
			{item.kind === 'owner_input' && item.nextAction && item.nextAction !== item.reason && <span className="block">{item.reason}</span>}
			<span className="block">{item.nextAction ?? item.reason}</span>
			{followUp && <span className="block">{followUp}</span>}
			{gap && <span className="block">{gap}</span>}
		</span>
	)
}

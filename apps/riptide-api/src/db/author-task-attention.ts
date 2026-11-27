import type { TaskAttention, TaskAttentionInputSchema } from '@humanlayer/schemas/zod/task-attention'
import { uuidv7 } from 'uuidv7'
import type { z } from 'zod/v4'

type Details = z.infer<typeof TaskAttentionInputSchema>

/** An edit to the same wait retains its receipt and acknowledgement unless its due date changes. */
export function authorTaskAttention(details: Details, owner: string, previous?: TaskAttention | null): TaskAttention {
	const occurrence = previous?.kind === details.kind ? previous : null
	const sameFollowUp = occurrence?.followUpAt === details.followUpAt
	const now = Date.now()
	return {
		...details,
		id: occurrence?.id ?? uuidv7(),
		authorizedBy: owner,
		revision: (occurrence?.revision ?? 0) + 1,
		openedAt: occurrence?.openedAt ?? now,
		updatedAt: now,
		acknowledgedAt: sameFollowUp ? occurrence?.acknowledgedAt : undefined,
		notice: sameFollowUp ? occurrence?.notice : undefined,
	}
}

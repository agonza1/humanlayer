import z from 'zod/v4'

import { DeliveryBlockerAlertSchema } from './automatic-delivery'
import { decodeJsonColumn } from './decode-json-column'

const Timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const text = (limit: number) => z.string().trim().min(1).max(limit)

const TaskAttentionDetails = z.object({
	kind: z.enum(['owner_input', 'external_wait']),
	reason: text(500),
	responsible: text(160),
	nextAction: text(500),
	evidence: text(2000).optional(),
	followUpAt: Timestamp.optional(),
})

function validFollowUp(attention: z.infer<typeof TaskAttentionDetails>) {
	return attention.kind === 'external_wait' || attention.followUpAt === undefined
}

const followUpError = { path: ['followUpAt'], message: 'Only an external wait can have a follow-up date.' }
export const TaskAttentionInputSchema = TaskAttentionDetails.refine(validFollowUp, followUpError)

export const TaskAttentionNoticeSchema = DeliveryBlockerAlertSchema.pick({
	id: true,
	slack: true,
	origin: true,
	slackRoute: true,
	standingSlackAttempt: true,
}).extend({ reservedAt: Timestamp })

export const TaskAttentionSchema = TaskAttentionDetails.extend({
	id: z.uuidv7(),
	revision: z.number().int().positive(),
	authorizedBy: z.string().min(1),
	openedAt: Timestamp,
	updatedAt: Timestamp,
	acknowledgedAt: Timestamp.optional(),
	resolvedAt: Timestamp.optional(),
	notice: TaskAttentionNoticeSchema.optional(),
}).refine(validFollowUp, followUpError)

export type TaskAttention = z.infer<typeof TaskAttentionSchema>
export type TaskAttentionNotice = z.infer<typeof TaskAttentionNoticeSchema>

/** Task sync may encode JSONB as a string. Treat absent legacy state as empty. */
export function decodeTaskAttention(value: unknown): TaskAttention | null {
	return decodeJsonColumn(TaskAttentionSchema, value)
}

import { TaskAttentionInputSchema, TaskAttentionSchema } from '@humanlayer/schemas/zod/task-attention'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

const cursor = z.object({ id: z.uuidv7(), revision: z.number().int().positive() })
const mutation = contractBuilder
	.errors({ CONFLICT: { status: 409 } })
	.output(z.object({ attention: TaskAttentionSchema.nullable() }))

export const setTaskAttentionContract = mutation.input(
	z.object({
		taskId: z.uuidv7(),
		expected: cursor
			.nullable()
			.describe('Current attention occurrence and revision. Pass null to open a new occurrence.'),
		attention: TaskAttentionInputSchema,
	}),
)
export const acknowledgeTaskAttentionContract = mutation.input(cursor.extend({ taskId: z.uuidv7() }))
export const clearTaskAttentionContract = mutation.input(cursor.extend({ taskId: z.uuidv7() }))

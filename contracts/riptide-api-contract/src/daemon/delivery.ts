import { DeliveryHeadSchema, DeliveryTargetSchema } from '@humanlayer/schemas/zod/automatic-delivery'
import z from 'zod/v4'

import { contractBuilder } from '../contract-builder'

export const DeliveryActionSchema = z.object({
	taskId: z.uuidv7(),
	leaseId: z.uuid(),
	kind: z.enum(['inspect', 'merge', 'archive']),
	targets: z.array(DeliveryTargetSchema),
	heads: z.array(DeliveryHeadSchema),
})
export type DeliveryAction = z.infer<typeof DeliveryActionSchema>
export const claimDeliveryContract = contractBuilder
	.input(z.object({}))
	.output(z.object({ action: DeliveryActionSchema.nullable() }))
export const validateDeliveryContract = contractBuilder
	.input(z.object({ taskId: z.uuidv7(), leaseId: z.uuid() }))
	.output(z.object({ authorized: z.boolean() }))
export const completeDeliveryContract = contractBuilder
	.input(
		z.object({
			taskId: z.uuidv7(),
			leaseId: z.uuid(),
			heads: z.array(DeliveryHeadSchema),
			error: z.string().max(30000).nullable(),
		}),
	)
	.output(z.object({ accepted: z.boolean() }))

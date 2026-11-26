import {
	AutomaticDeliverySchema,
	DeliveryAlertRoutesInputSchema,
	DeliveryReviewSchema,
	DeliveryTargetSchema,
} from '@humanlayer/schemas/zod/automatic-delivery'
import { ImplementationReconciliationSchema } from '@humanlayer/schemas/zod/implementation-reconciliation'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const configureDeliveryContract = contractBuilder
	.errors({ CONFLICT: { status: 409 } })
	.input(
		z.object({
			taskId: z.uuidv7(),
			mode: z.enum(['merge', 'pr-only', 'archive-only', 'disabled']),
			sourceSessionId: z.uuidv7(),
			targets: z.array(DeliveryTargetSchema).min(1).max(10),
			policyAcknowledgement: z
				.string()
				.min(1)
				.max(10000)
				.describe(
					'Explicit task-owner authorization after checking repository/company restrictions and human checkpoints; never inferred from existing auto-advance flags',
				),
		}),
	)
	.output(z.object({ delivery: AutomaticDeliverySchema.nullable() }))

export const reportDeliveryReviewContract = contractBuilder
	.input(
		z.object({
			taskId: z.uuidv7(),
			review: DeliveryReviewSchema,
		}),
	)
	.output(z.object({ accepted: z.boolean() }))

export const getDeliveryContract = contractBuilder
	.input(z.object({ taskId: z.uuidv7() }))
	.output(z.object({ delivery: AutomaticDeliverySchema.nullable() }))

export const configureDeliveryAlertsContract = contractBuilder
	.errors({ CONFLICT: { status: 409 } })
	.input(z.object({ taskId: z.uuidv7(), routes: DeliveryAlertRoutesInputSchema }))
	.output(
		z.object({
			delivery: AutomaticDeliverySchema.nullable(),
			reconciliation: ImplementationReconciliationSchema.nullable().optional(),
		}),
	)

export const acknowledgeDeliveryBlockerContract = contractBuilder
	.input(
		z.object({
			taskId: z.uuidv7(),
			alertId: z.uuid().describe('Current blocker ID from the task delivery status.'),
		}),
	)
	.output(z.object({ acknowledged: z.boolean() }))

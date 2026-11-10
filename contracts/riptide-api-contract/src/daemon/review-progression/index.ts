import { ReviewOutcomeSchema, ReviewPrBindingSchema } from '@humanlayer/db/zodschemas/review-progression'
import { ReviewReportReceiptSchema } from '@humanlayer/db/zodschemas/review-progression'
import { WorkspaceRepositoriesSchema } from '@humanlayer/schemas/zod/project-workspace'
import { WorkspaceSpecSchema } from '@humanlayer/schemas/zod/workspace'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import {
	ReviewProgressionBindingSchema,
	ReviewProgressionDigestSchema,
	ReviewProgressionEnrollmentSchema,
	ReviewProgressionPlacementSchema,
	ReviewScopeInputsSchema,
} from '../../lib/review-progression'
import { ReviewReturnInputSchema } from '../../lib/review-reporting'

export const ReviewProgressionSnapshotSchema = z.strictObject({
	taskId: z.uuid(),
	sourceSessionId: z.uuid(),
	executionSessionId: z.uuid().optional(),
	organizationId: z.uuid(),
	ownerUserId: z.string().min(1),
	hostId: z.string().min(1),
	enrollment: ReviewProgressionEnrollmentSchema,
	placement: ReviewProgressionPlacementSchema,
	acceptedLaunchDigest: ReviewProgressionDigestSchema,
	executionDigest: ReviewProgressionDigestSchema,
	scopeInputs: ReviewScopeInputsSchema,
	sourceCreatedAtMs: z.number().int().nonnegative(),
	scopeSha256: ReviewProgressionDigestSchema.nullable(),
	workingDirectory: z.string().min(1),
	repositories: WorkspaceRepositoriesSchema.nullable(),
	workspaceSpec: WorkspaceSpecSchema.nullable(),
	setupComplete: z.boolean(),
	verifiedBinding: ReviewProgressionBindingSchema.nullable(),
	bindingDigest: ReviewProgressionDigestSchema.nullable(),
})
export const ReviewProgressionAdmissionSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('not_enrolled') }),
	z.strictObject({ kind: z.literal('blocked'), reason: z.string().min(1).max(512) }),
	z.strictObject({ kind: z.literal('enrolled'), snapshot: ReviewProgressionSnapshotSchema }),
])
export type ReviewProgressionSnapshot = z.infer<typeof ReviewProgressionSnapshotSchema>
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/)
const identity = { taskId: z.uuid(), claimId: z.uuid(), generation: decimal }
export const ReviewClaimResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('claimed'),
		generation: decimal,
		claimedRevision: decimal,
		expiresAt: decimal,
		reconciliationRequired: z.boolean(),
		snapshot: ReviewProgressionSnapshotSchema,
		prBinding: ReviewPrBindingSchema.nullable(),
	}),
	z.strictObject({ kind: z.enum(['busy', 'stale', 'stopped', 'blocked']) }),
])
export const reviewProgressionContract = {
	claim: contractBuilder
		.input(z.strictObject({ taskId: z.uuid(), expectedWakeRevision: decimal, claimId: z.uuid() }))
		.output(ReviewClaimResultSchema),
	renew: contractBuilder.input(z.strictObject(identity)).output(z.strictObject({ expiresAt: decimal })),
	ack: contractBuilder
		.input(
			z.strictObject({
				...identity,
				claimedRevision: decimal,
				resultDigest: ReviewProgressionDigestSchema,
				validatedOutcome: ReviewOutcomeSchema,
			}),
		)
		.output(z.strictObject({ acknowledged: z.literal(true) })),
	recordDelivery: contractBuilder
		.input(
			z.union([
				ReviewReturnInputSchema,
				z.strictObject({
					...identity,
					claimedRevision: decimal,
					resultDigest: ReviewProgressionDigestSchema,
					validatedOutcome: ReviewOutcomeSchema,
					binding: ReviewPrBindingSchema,
				}),
			]),
		)
		.output(z.union([ReviewPrBindingSchema, ReviewReportReceiptSchema])),
	reports: contractBuilder.input(z.strictObject({ taskId: z.uuid() })).output(
		z.strictObject({
			snapshot: ReviewProgressionSnapshotSchema,
			codingAgentSessionId: z.string().nullable(),
			outcome: ReviewOutcomeSchema.nullable(),
			wakeRevision: decimal,
			planningSuspended: z.boolean(),
			receipts: z.array(ReviewReportReceiptSchema).max(64),
		}),
	),
	admission: contractBuilder.input(z.strictObject({ sessionId: z.uuid() })).output(ReviewProgressionAdmissionSchema),
	confirmPlacement: contractBuilder
		.input(
			z.strictObject({
				taskId: z.uuid(),
				sourceSessionId: z.uuid(),
				acceptedLaunchDigest: ReviewProgressionDigestSchema,
				bindingDigest: ReviewProgressionDigestSchema,
				binding: ReviewProgressionBindingSchema,
			}),
		)
		.output(ReviewProgressionBindingSchema),
}

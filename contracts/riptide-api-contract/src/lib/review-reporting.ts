import z from 'zod/v4'

import { ReviewProgressionDigestSchema, ReviewProgressionReferenceSchema } from './review-progression'

const handoff = z.strictObject({
	version: z.literal(1),
	kind: z.enum(['readiness', 'blocker']),
	enrollmentId: ReviewProgressionReferenceSchema,
	requestId: ReviewProgressionDigestSchema,
	outcomeKey: ReviewProgressionDigestSchema,
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	pr: z.number().int().positive().nullable(),
	headSha: z
		.string()
		.regex(/^[0-9a-f]{40}$/)
		.nullable(),
	scopeSha256: ReviewProgressionDigestSchema,
	evidenceRef: ReviewProgressionReferenceSchema,
})
const head = z.string().regex(/^[0-9a-f]{40}$/)
export const ReviewMergeResultSchema = z.union([
	z.strictObject({ status: z.enum(['merged', 'observed_external_merge']), headSha: head, mergeCommit: head }),
	z.strictObject({
		status: z.enum(['failed', 'declined', 'invalidated', 'merge_unknown']),
		headSha: head,
		reason: z
			.enum([
				'revalidation_failed',
				'github_rejected',
				'response_uncertain',
				'process_lost',
				'replacement_announced',
			])
			.optional(),
	}),
])
export const ReviewHandoffSchema = z.union([
	handoff.refine((value) => value.kind !== 'readiness' || (value.pr !== null && value.headSha !== null)),
	z
		.strictObject({
			...handoff.shape,
			kind: z.literal('merge_result'),
			pr: z.number().int().positive(),
			headSha: head,
			parentRequestId: ReviewProgressionDigestSchema,
			mergeResult: ReviewMergeResultSchema,
		})
		.refine((value) => value.mergeResult.headSha === value.headSha && value.evidenceRef === value.outcomeKey),
])
export type ReviewHandoff = z.infer<typeof ReviewHandoffSchema>
export const mergeOutcomeIdentity = (request: Extract<ReviewHandoff, { kind: 'merge_result' }>) => ({
	kind: 'merge_result',
	parentRequestId: request.parentRequestId,
	result: request.mergeResult,
})
export function reviewReportStatus(request: ReviewHandoff, deliveryStatus: string) {
	return request.kind === 'merge_result'
		? request.mergeResult.status
		: request.kind === 'readiness' && deliveryStatus === 'delivered'
			? 'ready_for_human_approval'
			: 'needs_decision'
}
export const ReviewReturnInputSchema = z.strictObject({
	kind: z.literal('return_receipt'),
	taskId: z.uuid(),
	sourceSessionId: z.uuid(),
	request: ReviewHandoffSchema,
	deliveryStatus: z.enum(['delivered', 'failed', 'unknown']),
	destinationSlot: z.enum(['origin_session', 'artifact']),
	receiptIdentity: z.uuid(),
	contentDigest: ReviewProgressionDigestSchema,
})
export const ReviewPassiveNoteSchema = z
	.strictObject({
		kind: z.literal('review_progression'),
		version: z.literal(1),
		outcomeKey: ReviewProgressionDigestSchema,
		status: z.enum([
			'ready_for_human_approval',
			'needs_decision',
			'merged',
			'failed',
			'declined',
			'invalidated',
			'merge_unknown',
			'observed_external_merge',
		]),
		repository: handoff.shape.repository,
		pr: handoff.shape.pr,
		headSha: handoff.shape.headSha,
		reportArtifact: z.string().regex(/^review-report-[0-9a-f]{64}\.md$/),
	})
	.refine(
		(value) =>
			value.reportArtifact === `review-report-${value.outcomeKey}.md` &&
			(value.status === 'needs_decision' || (value.pr !== null && value.headSha !== null)),
	)

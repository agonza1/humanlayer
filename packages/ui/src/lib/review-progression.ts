import z from 'zod/v4'

export const ReviewProgressionNoteSchema = z.strictObject({
	kind: z.literal('review_progression'),
	version: z.literal(1),
	outcomeKey: z.string().regex(/^[0-9a-f]{64}$/),
	status: z.enum(['ready_for_human_approval', 'needs_decision', 'merged', 'failed', 'declined', 'invalidated', 'merge_unknown', 'observed_external_merge']),
	repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	pr: z.number().int().positive().nullable(),
	headSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
	reportArtifact: z.string().max(255).regex(/^review-report-[0-9a-f]{64}\.md$/),
}).refine((value) => value.status === 'needs_decision' || (value.pr !== null && value.headSha !== null))
export type ReviewProgressionNote = z.infer<typeof ReviewProgressionNoteSchema>

export function parseReviewProgressionNote(event: {
	eventType: string
	role?: string
	content?: string | null
}): ReviewProgressionNote | null {
	if (event.eventType !== 'system' || event.role !== 'system' || !event.content || event.content.length > 4096) return null
	try {
		const parsed = ReviewProgressionNoteSchema.safeParse(JSON.parse(event.content))
		if (!parsed.success || parsed.data.reportArtifact !== `review-report-${parsed.data.outcomeKey}.md`) return null
		return parsed.data
	} catch {
		return null
	}
}

export const reviewProgressionLabels: Record<ReviewProgressionNote['status'], string> = {
	ready_for_human_approval: 'Review is ready for your decision',
	needs_decision: 'Review needs your attention',
	merged: 'Pull request merged',
	failed: 'Could not complete the requested action',
	merge_unknown: 'Could not confirm the merge',
	declined: 'Merge declined',
	invalidated: 'Earlier approval request replaced',
	observed_external_merge: 'Pull request merge observed on GitHub',
}

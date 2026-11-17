import z from 'zod/v4'

export const ProjectDeliveryModeSchema = z.enum(['off', 'pr-only', 'merge'])
export const TaskDeliveryOverrideSchema = z.enum(['inherit', 'off', 'pr-only', 'merge'])
export const TaskDeliverySnapshotSchema = z.object({
	mode: ProjectDeliveryModeSchema,
	authorizedBy: z.string(),
	authorizedAt: z.number(),
})
export type TaskDeliverySnapshot = z.infer<typeof TaskDeliverySnapshotSchema>

export function snapshotProjectDelivery(input: {
	projectOwner: string
	taskOwner: string
	projectMode: z.infer<typeof ProjectDeliveryModeSchema>
	override?: z.infer<typeof TaskDeliveryOverrideSchema>
}): TaskDeliverySnapshot {
	const mode =
		input.override && input.override !== 'inherit'
			? input.override
			: input.projectOwner === input.taskOwner
				? input.projectMode
				: 'off'
	return { mode, authorizedBy: input.taskOwner, authorizedAt: Date.now() }
}

export const DeliveryTargetSchema = z.object({
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	branch: z.string().min(1).max(255),
	base: z.string().min(1).max(255),
	directory: z.string().min(1),
})
export const DeliveryHeadSchema = DeliveryTargetSchema.extend({
	number: z.number().int().positive(),
	sha: z.string().regex(/^[a-f0-9]{40}$/),
	merged: z.boolean(),
})
export const DeliveryReviewSchema = z.object({
	sessionId: z.uuid(),
	source: z.enum(['automatic', 'local-qa']),
	verdict: z.enum(['clean', 'repair', 'uncertain', 'blocked']),
	automaticMergeAllowed: z.boolean(),
	humanCheckpointsSatisfied: z.boolean(),
	heads: z.array(DeliveryHeadSchema).min(1),
	findings: z
		.array(
			z.object({
				priority: z.enum(['P0', 'P1', 'P2', 'P3']),
				verified: z.boolean(),
				related: z.boolean(),
				detail: z.string().min(1).max(10000),
			}),
		)
		.max(100),
	evidence: z.string().min(1).max(30000),
})
export const AutomaticDeliverySchema = z.object({
	version: z.literal(1),
	authorizedBy: z.string(),
	authorizedAt: z.number(),
	mode: z.enum(['merge', 'pr-only', 'archive-only']),
	hostId: z.string(),
	sourceSessionId: z.uuid(),
	targets: z.array(DeliveryTargetSchema).min(1).max(10),
	policyAcknowledgement: z.string().min(1),
	phase: z.enum([
		'implementation',
		'pr',
		'inspect',
		'review',
		'repair',
		'merge',
		'archive',
		'attention',
		'archived',
		'disabled',
	]),
	passes: z.number().int().min(0).max(3),
	recoveryAttempts: z.number().int().min(0).max(1),
	managedSessionId: z.uuid().nullable(),
	managedAt: z.number(),
	deliverySessionIds: z.array(z.uuid()).max(10),
	workRevision: z.string(),
	heads: z.array(DeliveryHeadSchema),
	reviews: z.array(DeliveryReviewSchema).max(3),
	attention: z.string().nullable(),
	lease: z
		.object({
			id: z.uuid(),
			kind: z.enum(['inspect', 'merge', 'archive']),
			expiresAt: z.number(),
			revision: z.string(),
		})
		.nullable(),
})
export type AutomaticDelivery = z.infer<typeof AutomaticDeliverySchema>
export type DeliveryHead = z.infer<typeof DeliveryHeadSchema>
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>

export function decodeDelivery(value: unknown): AutomaticDelivery | null {
	if (value === null || value === undefined) return null
	return AutomaticDeliverySchema.parse(typeof value === 'string' ? JSON.parse(value) : value)
}

export function sameDeliveryHeads(left: DeliveryHead[], right: DeliveryHead[]): boolean {
	const key = (head: DeliveryHead) =>
		JSON.stringify([head.repository.toLowerCase(), head.branch, head.base, head.directory, head.number, head.sha])
	return (
		left.length > 0 &&
		left.length === right.length &&
		left.map(key).sort().join('\n') === right.map(key).sort().join('\n')
	)
}

export function deliveryReviewVerdict(review: DeliveryReview): 'clean' | 'repair' | 'attention' {
	if (!review.humanCheckpointsSatisfied) return 'attention'
	if (review.verdict === 'blocked' || review.verdict === 'uncertain') return 'attention'
	if (review.findings.some((finding) => !finding.verified)) return 'attention'
	if (review.findings.some((finding) => !finding.related && (finding.priority === 'P0' || finding.priority === 'P1')))
		return 'attention'
	if (review.findings.some((finding) => finding.related && ['P0', 'P1', 'P2'].includes(finding.priority)))
		return 'repair'
	if (review.verdict === 'repair' && review.findings.length === 0) return 'attention'
	return 'clean'
}

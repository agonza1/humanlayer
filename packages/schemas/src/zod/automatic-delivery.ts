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
export const DeliveryCommitSchema = DeliveryTargetSchema.extend({
	sha: z.string().regex(/^[a-f0-9]{40}$/),
})
export const DeliveryHeadSchema = DeliveryCommitSchema.extend({
	number: z.number().int().positive(),
	merged: z.boolean(),
	// Older hosts do not report draft state. Read-only legacy reconciliation requires it.
	draft: z.boolean().optional(),
})
export const DELIVERY_CHECKOUT_BLOCKER =
	'Local checkout has newer/uncommitted work, a different branch, or a different repository'

export const DeliveryInspectionIssueSchema = z.enum([
	'checkout',
	'pr-missing',
	'pr-ambiguous',
	'pr-head-mismatch',
	'remote-head-mismatch',
])
export type DeliveryInspectionIssue = z.infer<typeof DeliveryInspectionIssueSchema>

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
const SlackAlertModeSchema = z.enum(['inherit', 'off'])

export const DeliveryAlertRoutesInputSchema = z
	.object({
		slackAutomationId: z.uuid().optional(),
		slackMode: SlackAlertModeSchema.optional(),
		origin: z
			.discriminatedUnion('kind', [
				z.object({ kind: z.literal('session'), sessionId: z.uuid() }),
				z.object({ kind: z.literal('slack'), automationId: z.uuid() }),
			])
			.optional(),
	})
	.refine((routes) => !routes.slackAutomationId || !routes.slackMode, {
		message: 'Choose either a specific Slack automation or a Slack mode.',
	})

export const DeliveryAlertSlackRouteSchema = z.object({
	automationId: z.uuid(),
	channelId: z.string(),
	teamId: z.string(),
	threadId: z.uuid().optional(),
	threadTs: z.string().optional(),
	localRelay: z.literal(true).optional(),
})
export type DeliveryAlertSlackRoute = z.infer<typeof DeliveryAlertSlackRouteSchema>

const DeliveryAlertReceiptSchema = z.discriminatedUnion('status', [
	z.object({ status: z.enum(['pending', 'unavailable', 'failed']) }),
	z.object({ status: z.literal('unknown'), destination: z.string().optional() }),
	z.object({ status: z.literal('delivered'), receipt: z.string().min(1), destination: z.string().optional() }),
])
export type DeliveryAlertReceipt = z.infer<typeof DeliveryAlertReceiptSchema>

export const DeliveryAlertRoutesSchema = z.object({
	slack: DeliveryAlertSlackRouteSchema.optional(),
	slackMode: SlackAlertModeSchema.optional(),
	origin: z
		.discriminatedUnion('kind', [
			z.object({ kind: z.literal('session'), sessionId: z.uuid() }),
			z.object({ kind: z.literal('slack'), route: DeliveryAlertSlackRouteSchema }),
		])
		.optional(),
})
const BlockerAlertReceiptsSchema = z.object({
	id: z.uuid(),
	slack: DeliveryAlertReceiptSchema,
	origin: DeliveryAlertReceiptSchema,
	slackRoute: z.enum(['standing', 'specific', 'off', 'unavailable']).optional(),
	standingSlackAttempt: z.string().optional(),
})

export const DeliveryBlockerAlertSchema = BlockerAlertReceiptsSchema.extend({
	openedAt: z.number().optional(),
	exhaustedAt: z.number().optional(),
	acknowledgedAt: z.number().optional(),
	reminder: BlockerAlertReceiptsSchema.extend({ reservedAt: z.number() }).optional(),
})

export const DELIVERY_DIAGNOSIS_LABEL = 'rpi:delivery-diagnosis'
export const DELIVERY_DIAGNOSIS_MODEL = 'gpt-6.2-sol'

export const DeliveryAttentionDiagnosisSchema = z
	.object({
		reason: z
			.string()
			.trim()
			.min(1)
			.max(350)
			.regex(/^[^\p{Cc}\p{Cf}]+$/u),
		nextAction: z
			.string()
			.trim()
			.min(1)
			.max(250)
			.regex(/^[^\p{Cc}\p{Cf}]+$/u),
	})
	.strict()

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
	recoveredCommits: z.array(DeliveryCommitSchema).min(1).max(10).optional(),
	reviews: z.array(DeliveryReviewSchema).max(3),
	attention: z.string().nullable(),
	attentionDiagnosis: DeliveryAttentionDiagnosisSchema.optional(),
	attentionDuringPublication: z.boolean().optional(),
	// The original review budget still applies. Keep the one-shot marker after failure or archive.
	mergedPublicationRecovery: z.literal(true).optional(),
	attentionObservation: z
		.object({ checkedAt: z.number(), changedAt: z.number().optional(), heads: z.array(DeliveryHeadSchema).max(10) })
		.optional(),
	alertRoutes: DeliveryAlertRoutesSchema.optional(),
	blockerAlert: DeliveryBlockerAlertSchema.optional(),
	lease: z
		.object({
			id: z.uuid(),
			kind: z.enum(['inspect', 'merge', 'archive', 'recover', 'observe']),
			expiresAt: z.number(),
			revision: z.string(),
			canRecoverMergedPublication: z.literal(true).optional(),
		})
		.nullable(),
})
export type AutomaticDelivery = z.infer<typeof AutomaticDeliverySchema>
export type DeliveryHead = z.infer<typeof DeliveryHeadSchema>
export type DeliveryCommit = z.infer<typeof DeliveryCommitSchema>
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>

export function decodeDelivery(value: unknown): AutomaticDelivery | null {
	if (value === null || value === undefined) return null
	return AutomaticDeliverySchema.parse(typeof value === 'string' ? JSON.parse(value) : value)
}

export const MERGED_PR_ATTENTION = 'PR merged on GitHub. Verify remaining acceptance before completing this task.'

export function mergedAttentionObservation(delivery?: AutomaticDelivery) {
	const observed = delivery?.attentionObservation
	if (observed && observed.heads.length === delivery?.targets.length && observed.heads.every((head) => head.merged))
		return observed
	return undefined
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

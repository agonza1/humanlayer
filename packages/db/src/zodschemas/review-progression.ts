import { WorkspaceRepositoriesSchema } from '@humanlayer/schemas/zod/project-workspace'
import { WorkspaceSpecSchema } from '@humanlayer/schemas/zod/workspace'
import z from 'zod/v4'

export const ReviewProgressionReferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$(?![\s\S])/)
export const ReviewProgressionEnrollmentSchema = z.strictObject({
	enrollmentId: ReviewProgressionReferenceSchema,
	returnRouteRef: ReviewProgressionReferenceSchema,
})
export const ReviewProgressionDigestSchema = z
	.string()
	.length(64)
	.regex(/^[0-9a-f]{64}$/)
export const ReviewProgressionPlacementSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('project_workspace'),
		projectId: z.uuid(),
		workspaceId: z.uuid(),
		setupRowId: z.null(),
	}),
	z.strictObject({
		kind: z.literal('legacy_directory'),
		projectId: z.null(),
		workspaceId: z.null(),
		setupRowId: z.uuid(),
		workspaceSpecDigest: ReviewProgressionDigestSchema.nullable(),
	}),
])
const absolutePath = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^\/[^\x00\r\n]*$(?![\s\S])/)
export const ReviewProgressionBindingSchema = z.strictObject({
	workingDirectory: absolutePath,
	repositoryDirectory: absolutePath,
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$(?![\s\S])/),
	branch: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[^\s\x00-\x1f]+$(?![\s\S])/),
	helperConfigDigest: ReviewProgressionDigestSchema,
})
export type ReviewProgressionEnrollment = z.infer<typeof ReviewProgressionEnrollmentSchema>
export type ReviewProgressionPlacement = z.infer<typeof ReviewProgressionPlacementSchema>
export type ReviewProgressionBinding = z.infer<typeof ReviewProgressionBindingSchema>

export const REVIEW_TASK_SCOPE_FIELDS = [
	'id',
	'name',
	'slug',
	'project_id',
	'workspace_id',
	'resource_owner_user_id',
	'ticket_id',
	'ticket_url',
	'ticket_provider',
	'ticket_description',
	'github_connection_id',
	'ticket_repository_id',
	'ticket_repository_full_name',
] as const
export const ReviewAcceptedArtifactSchema = z.strictObject({
	fileName: z
		.string()
		.min(1)
		.max(255)
		.refine(
			(name) =>
				name !== '.' &&
				name !== '..' &&
				!/[/\\\x00-\x1f]/.test(name) &&
				!name.startsWith('review-delivery-context-'),
		),
	storageType: z.enum(['postgres', 's3']),
	contentHash: z.string().min(1),
	contentType: z.string().min(1),
	fileSizeBytes: z
		.number()
		.int()
		.nonnegative()
		.max(50 * 1024 * 1024),
	bytesSha256: ReviewProgressionDigestSchema,
})
export const ReviewScopeInputsSchema = z.strictObject({
	task: z.strictObject({
		id: z.uuid(),
		name: z.string(),
		slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
		project_id: z.uuid().nullable(),
		workspace_id: z.uuid().nullable(),
		resource_owner_user_id: z.string(),
		ticket_id: z.string().nullable(),
		ticket_url: z.string().nullable(),
		ticket_provider: z.string().nullable(),
		ticket_description: z.string().nullable(),
		github_connection_id: z.string().nullable(),
		ticket_repository_id: z.string().nullable(),
		ticket_repository_full_name: z.string().nullable(),
	}),
	accepted: z.string().min(1),
	artifacts: z.array(ReviewAcceptedArtifactSchema).min(1).max(100),
	placement: ReviewProgressionPlacementSchema,
	repositories: WorkspaceRepositoriesSchema.nullable(),
	workspaceSpec: WorkspaceSpecSchema.nullable(),
})
export type ReviewAcceptedArtifact = z.infer<typeof ReviewAcceptedArtifactSchema>
export type ReviewScopeInputs = z.infer<typeof ReviewScopeInputsSchema>

export const ReviewContinuationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('wait'), nextWakeAt: z.iso.datetime(), actionId: z.uuid().optional() }),
	z.strictObject({ kind: z.literal('reconcile'), progressKey: ReviewProgressionDigestSchema }),
	z.strictObject({ kind: z.literal('stop') }),
])
export const ReviewPrBindingSchema = z.strictObject({
	repository: ReviewProgressionBindingSchema.shape.repository,
	pr: z.number().int().positive(),
	branch: ReviewProgressionBindingSchema.shape.branch,
	headSha: z.string().regex(/^[0-9a-f]{40}$/),
	scopeSha256: ReviewProgressionDigestSchema,
	sourceSessionId: z.uuid(),
})
export const ReviewOutcomeSchema = z.strictObject({
	status: z.enum([
		'delivery_observed',
		'waiting_writer',
		'waiting_review',
		'reviewed',
		'review_clean',
		'repaired',
		'ready_for_human_approval',
		'needs_decision',
		'completed',
		'closed',
	]),
	reason: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[a-z][a-z0-9_]*$/),
	context: z
		.strictObject({
			repository: ReviewProgressionBindingSchema.shape.repository,
			taskId: z.uuid(),
			scopeSha256: ReviewProgressionDigestSchema,
			pr: z.number().int().positive().nullable(),
			headSha: z
				.string()
				.regex(/^[0-9a-f]{40}$/)
				.nullable(),
		})
		.nullable(),
	continuation: ReviewContinuationSchema,
	verified: z.boolean().optional(),
})
export type ReviewContinuation = z.infer<typeof ReviewContinuationSchema>
export type ReviewPrBinding = z.infer<typeof ReviewPrBindingSchema>
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>

export const ReviewReportReceiptSchema = z.strictObject({
	requestId: ReviewProgressionDigestSchema,
	outcomeKey: ReviewProgressionDigestSchema,
	destinationSlot: z.enum(['origin_session', 'artifact']),
	receiptIdentity: z.uuid(),
	contentDigest: ReviewProgressionDigestSchema,
})
export type ReviewReportReceipt = z.infer<typeof ReviewReportReceiptSchema>

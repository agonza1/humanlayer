import z from 'zod/v4'

import { DeliveryBlockerAlertSchema, DeliveryAlertRoutesSchema, DeliveryHeadSchema } from './automatic-delivery'

export const IMPLEMENTATION_BLOCKERS = {
	'owner-required':
		'The implementation session belongs to a collaborator. Ask the task owner to verify the active workspace and delivery.',
	'host-unavailable':
		'The implementation host is offline. Reconnect that host to verify the checkout and resume this task.',
	'writer-unknown':
		'The previous implementation writer could not be confirmed stopped. Verify the host and session before resuming.',
	'session-stopped':
		'Implementation stopped before a result was verified. Open the last session and confirm whether to resume or publish the work.',
	'approval-required': 'The workflow is waiting for approval. Open the session and decide whether to continue.',
	'usage-limit': 'The workflow reached a usage limit. Open the session to check when it can resume.',
	'publication-unavailable':
		'Describe PR could not start or finish on the assigned host. Open the Describe PR session and check its host and workspace.',
	'workspace-required':
		'HumanLayer cannot identify every task repository and branch. Attach the correct workspace or verify the task branch with the owner.',
	'checkout-changed':
		'The task checkout contains uncommitted work or has a different branch or remote. Verify the workspace and finish or publish the accepted work.',
	'pr-missing':
		'No PR is open for a tracked task branch. Publish the completed work or confirm that implementation still needs to continue.',
	'pr-ambiguous': 'More than one PR matches a tracked task branch. Confirm which PR delivers this task.',
	'head-mismatch':
		'A PR or remote branch no longer matches the task checkout. Check the exact task branch and head before review.',
	'pr-not-ready':
		'A task PR is still a draft or the host could not confirm its draft status. Mark the PR ready when it can be reviewed and refresh verification.',
	'verification-failed':
		'HumanLayer could not verify a unique, current-head PR for every task branch. Publish the work or verify the repository, branch, and GitHub access for this task.',
	'verification-expired':
		'Current-head verification did not finish before its deadline. Reconnect the implementation host or check its GitHub access.',
	'review-required':
		'Delivery is verified at the current PR heads. Assign independent review or explicitly enable it for this task.',
	'enrollment-unavailable':
		'The saved delivery choice could not be applied. Check the task workspace, host, and delivery permissions.',
} as const

export type ImplementationBlocker = keyof typeof IMPLEMENTATION_BLOCKERS

const ReasonSchema = z.enum(Object.keys(IMPLEMENTATION_BLOCKERS) as [ImplementationBlocker, ...ImplementationBlocker[]])
const StageSchema = z.enum(['implementation', 'in-review'])

export const ImplementationReconciliationSchema = z.object({
	version: z.literal(1),
	decision: z
		.discriminatedUnion('status', [
			z.object({ status: z.literal('verifying'), deadlineAt: z.number(), hostId: z.string() }),
			z.object({ status: z.literal('waiting-publication'), sessionId: z.uuid(), deadlineAt: z.number() }),
			z.object({ status: z.literal('review') }),
			z.object({ status: z.literal('blocked'), reason: ReasonSchema, stage: StageSchema }),
		])
		.nullable(),
	wakeAt: z.number().optional(),
	revision: z.string().optional(),
	inspectionAttempts: z.number().int().min(0).max(2).optional(),
	heads: z.array(DeliveryHeadSchema).max(10).optional(),
	lease: z.object({ id: z.uuid(), hostId: z.string(), expiresAt: z.number() }).optional(),
	alertRoutes: DeliveryAlertRoutesSchema.optional(),
	blockerAlert: DeliveryBlockerAlertSchema.optional(),
})

export type ImplementationReconciliation = z.infer<typeof ImplementationReconciliationSchema>

export function decodeImplementationReconciliation(value: unknown): ImplementationReconciliation | null {
	try {
		return (
			ImplementationReconciliationSchema.safeParse(typeof value === 'string' ? JSON.parse(value) : value).data ??
			null
		)
	} catch {
		return null
	}
}

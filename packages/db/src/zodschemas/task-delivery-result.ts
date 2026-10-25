import z from 'zod/v4'

/** Owner-published delivery outcome, written only after the controller confirms a merge. */
export const TaskDeliveryResultSchema = z.object({
	status: z.literal('merged'),
	pullRequestUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/),
	headSha: z.string().regex(/^[a-f0-9]{40}$/),
})
export type TaskDeliveryResult = z.infer<typeof TaskDeliveryResultSchema>

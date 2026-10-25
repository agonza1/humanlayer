import z from 'zod/v4'

/** Main records verified native Codex chat handoffs; this metadata does not dispatch agents. */
export const TaskNativeExecutionSchema = z
	.object({
		mode: z.literal('main-mediated'),
		stage: z.enum(['implementation', 'in_review', 'blocked']),
		repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
		directory: z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
		coderThreadId: z.uuid(),
		qaThreadId: z
			.uuid()
			.transform((id) => id.toLowerCase())
			.optional(),
		headSha: z
			.string()
			.regex(/^[a-f0-9]{40}$/)
			.optional(),
		reason: z.string().min(1).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.stage === 'in_review' && (!value.qaThreadId || !value.headSha))
			ctx.addIssue({ code: 'custom', message: 'Review requires the QA chat and reviewed commit' })
		if (value.qaThreadId?.toLowerCase() === value.coderThreadId.toLowerCase())
			ctx.addIssue({ code: 'custom', message: 'QA must use an independent chat' })
		if (value.stage === 'blocked' && !value.reason)
			ctx.addIssue({ code: 'custom', message: 'Blocked execution requires a reason' })
	})
export type TaskNativeExecution = z.infer<typeof TaskNativeExecutionSchema>

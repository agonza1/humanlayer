import z from 'zod/v4'

import { contractBuilder } from '../../../../contract-builder'

/** A session's task, ranked for the session; or a task on its own. */
export const PullRequestScopeSchema = z.union([z.object({ sessionId: z.uuid() }), z.object({ taskId: z.uuid() })])
export type PullRequestScope = z.infer<typeof PullRequestScopeSchema>

/** Picks one of the scope's repositories by repository and branch; omit both to let the server choose. */
export const PullRequestRepoSelectionSchema = z.object({
	repoFullName: z.string().min(3).optional(),
	branch: z.string().min(1).optional(),
})

export const EnsurePullRequestStreamInputSchema = z.intersection(PullRequestScopeSchema, PullRequestRepoSelectionSchema)

export const EnsurePullRequestStreamOutputSchema = z.object({
	streamPath: z.string(),
	repoFullName: z.string(),
	branch: z.string(),
	hasPullRequest: z.boolean(),
	/** A fresh GitHub answer for board completion; absent on older API builds. */
	delivery: z
		.object({
			number: z.number().int(),
			state: z.enum(['open', 'closed', 'merged']),
			headSha: z.string(),
			branchHeadSha: z.string().nullable(),
			mergedAt: z.string().nullable(),
		})
		.nullable()
		.optional(),
})

export const ensurePullRequestStreamContract = contractBuilder
	.input(EnsurePullRequestStreamInputSchema)
	.output(EnsurePullRequestStreamOutputSchema)

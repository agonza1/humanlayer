import type { Session } from '@humanlayer/db/tables/sessions'
import z from 'zod/v4'

export const PlanningSkillSchema = z.enum([
	'rpi:research-questions',
	'rpi:research',
	'rpi:design',
	'rpi:design-prd',
	'rpi:design-tdd',
	'rpi:structure',
	'rpi:plan',
])
export type PlanningSkill = z.infer<typeof PlanningSkillSchema>
export const WorkEntryFields = {
	executionPhase: z.enum(['implementation', 'review']).nullable().optional(),
	planningSkill: PlanningSkillSchema.optional(),
}
export type WorkEntry = { executionPhase?: 'implementation' | 'review' | null; planningSkill?: PlanningSkill }
export const WorkflowMutationSchema = z.strictObject({
	expectedRevision: z
		.string()
		.max(19)
		.regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
		.refine((value) => BigInt(value) < 9223372036854775807n),
	mutationDigest: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
})
export const WORKFLOW_FIELDS = [
	'workflowType',
	'autoAdvanceQuestionsToResearch',
	'autoAdvanceResearchToDesign',
	'autoAdvancePlanToWorktree',
	'autoAdvanceWorktreeToImplementation',
	'autoAdvanceImplementationToPr',
] as const
export type WorkflowPatch = {
	workflowType?: string
	autoAdvanceQuestionsToResearch?: boolean
	autoAdvanceResearchToDesign?: boolean
	autoAdvancePlanToWorktree?: boolean
	autoAdvanceWorktreeToImplementation?: boolean
	autoAdvanceImplementationToPr?: boolean
}
export const workflowPatch = (input: WorkflowPatch): WorkflowPatch =>
	Object.fromEntries(WORKFLOW_FIELDS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
export const workflowMutationPayload = (taskId: string, expectedRevision: string, patch: WorkflowPatch) => ({
	version: 1,
	taskId,
	expectedRevision,
	patch,
})

export function validateWorkEntry(
	entry: WorkEntry,
	workflow: string,
	existing?: Pick<Session, 'labels' | 'execution_phase'>,
): void {
	if (entry.executionPhase !== null) {
		if (entry.planningSkill !== undefined)
			throw new Error('Could not start planning. Select a planning phase with its skill.')
		return
	}
	const skill = entry.planningSkill
	const allowed = {
		freeform: ['rpi:research'],
		oneshot: [],
		rpi: ['rpi:research-questions', 'rpi:research', 'rpi:design', 'rpi:structure', 'rpi:plan'],
		outline_only: ['rpi:research-questions', 'rpi:research', 'rpi:design', 'rpi:structure'],
		prd_tdd: ['rpi:research-questions', 'rpi:research', 'rpi:design-prd', 'rpi:design-tdd', 'rpi:structure'],
	} satisfies {
		[Workflow in 'freeform' | 'oneshot' | 'rpi' | 'outline_only' | 'prd_tdd']: readonly PlanningSkill[]
	}
	const skills = Object.entries(allowed).find(([name]) => name === workflow)?.[1]
	if (!skill || !skills?.some((candidate) => candidate === skill))
		throw new Error('Could not start planning. Select a skill supported by this task workflow.')
	if (
		existing &&
		(existing.execution_phase !== null ||
			!existing.labels?.some((label) => label.name === skill) ||
			existing.labels.some((label) =>
				['rpi:implementation', 'rpi:review', 'rpi:describe-pr'].includes(label.name),
			))
	)
		throw new Error('Could not resume planning in this session. Start a planning session on the same task.')
}

export function workEntryValues(
	entry: WorkEntry,
	now: bigint,
): Partial<Pick<Session, 'execution_phase' | 'execution_phase_at' | 'labels'>> {
	if (entry.executionPhase === undefined) return {}
	const values: Partial<Pick<Session, 'execution_phase' | 'execution_phase_at' | 'labels'>> = {
		execution_phase: entry.executionPhase,
		execution_phase_at: now,
	}
	if (entry.executionPhase === null) {
		const skill = PlanningSkillSchema.parse(entry.planningSkill)
		values.labels = [{ name: skill, title: skill.slice(4) }]
	}
	return values
}

export {
	ReviewProgressionReferenceSchema,
	ReviewProgressionEnrollmentSchema,
	ReviewProgressionPlacementSchema,
	ReviewProgressionBindingSchema,
	ReviewProgressionDigestSchema,
	ReviewAcceptedArtifactSchema,
	ReviewScopeInputsSchema,
	REVIEW_TASK_SCOPE_FIELDS,
} from '@humanlayer/db/zodschemas/review-progression'
export type {
	ReviewProgressionEnrollment,
	ReviewProgressionPlacement,
	ReviewProgressionBinding,
	ReviewAcceptedArtifact,
	ReviewScopeInputs,
} from '@humanlayer/db/zodschemas/review-progression'

export function canonicalReviewValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalReviewValue).join(',')}]`
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalReviewValue(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

export const REVIEW_EXECUTION_FIELDS = [
	'id',
	'task_id',
	'organization_id',
	'created_by',
	'resource_owner_user_id',
	'host_id',
	'status',
	'archived',
	'working_directory',
	'prompt',
	'coding_agent',
	'coding_agent_session_id',
	'provider',
	'model',
	'effort',
	'fast_mode',
	'permissions_mode',
	'workflow_type',
	'forked_from_session_id',
	'handoff_source_session_id',
	'fork_data',
	'execution_phase',
	'execution_phase_at',
] as const satisfies readonly (keyof Session)[]
export type ReviewExecutionSession = Pick<Session, (typeof REVIEW_EXECUTION_FIELDS)[number]>
export const reviewExecutionPayload = (session: ReviewExecutionSession) =>
	Object.fromEntries(
		REVIEW_EXECUTION_FIELDS.map((key) => [
			key,
			typeof session[key] === 'bigint' ? String(session[key]) : session[key],
		]),
	)

export const hasSameSessionDelivery = (text: string) =>
	text.includes('DeliveryReportV1') && /\bsame[- ]session\b/i.test(text) && !text.includes('/rpi:describe-pr')

export const reviewDeliveryContextFile = (sourceId: string) => `review-delivery-context-${sourceId}.json`
export const reviewHelperScope = (
	inputs: import('@humanlayer/db/zodschemas/review-progression').ReviewScopeInputs,
	binding: import('@humanlayer/db/zodschemas/review-progression').ReviewProgressionBinding,
) => ({ version: 1 as const, ...inputs, binding })

export const reviewDeliveryContext = (snapshot: {
	taskId: string
	sourceSessionId: string
	acceptedLaunchDigest: string
	scopeSha256: string | null
}) => ({
	version: 1 as const,
	taskId: snapshot.taskId,
	sourceId: snapshot.sourceSessionId,
	acceptedLaunchDigest: snapshot.acceptedLaunchDigest,
	scopeSha256: snapshot.scopeSha256,
})

export const SAME_SESSION_DELIVERY =
	'Read review-delivery-context-SOURCE_ID.json in this task directory for the confirmed scopeSha256, using this session ID for SOURCE_ID. Do not substitute the acceptedLaunchDigest or modify that context. Implement the accepted task, run meaningful local checks, self-review the whole diff, commit, non-force push, and create or update the pull request in this same session within the accepted authority. Do not start a Describe PR successor. Independent review stays separate. Publish delivery-result-SOURCE_ID.json as a task artifact using the closed DeliveryReportV1: {"version":1,"sourceId":"SOURCE_ID","repository":"owner/repo","branch":"attached-branch","headSha":"published-sha","prNumber":1,"scopeSha256":"accepted-scope-sha256","selfReview":{"completed":true,"evidenceRef":"artifact-reference"},"acceptance":{"satisfied":true,"evidenceRef":"artifact-reference"},"checks":{"status":"satisfied","evidenceRef":"artifact-reference"}}. Replace every placeholder with verified evidence, including SOURCE_ID with this session ID; do not invent a scope digest or evidence. Checks may instead be {"status":"not_required","evidenceRef":"artifact-reference","reason":"justification"}. Report missing evidence honestly without claiming delivery. This launch does not authorize merge, deployment, installation, or live sends.'

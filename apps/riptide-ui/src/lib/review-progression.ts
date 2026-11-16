import type { RiptideApiInputs } from '@humanlayer/riptide-api-contract/contract-router'
import {
	ReviewProgressionEnrollmentSchema,
	SAME_SESSION_DELIVERY,
	type ReviewProgressionEnrollment,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import {
	canonicalReviewValue,
	PlanningSkillSchema,
	validateWorkEntry,
	workflowPatch,
	workflowMutationPayload,
	type WorkEntry,
} from '@humanlayer/riptide-api-contract/lib/review-progression'

export type ReviewDeliveryChoice = { enabled: boolean; enrollmentId: string; returnRouteRef: string }
export const emptyReviewDelivery = (): ReviewDeliveryChoice => ({
	enabled: false,
	enrollmentId: '',
	returnRouteRef: '',
})
export function reviewDeliveryEnrollment(choice: ReviewDeliveryChoice): ReviewProgressionEnrollment | undefined {
	return choice.enabled
		? ReviewProgressionEnrollmentSchema.parse({
				enrollmentId: choice.enrollmentId,
				returnRouteRef: choice.returnRouteRef,
			})
		: undefined
}
export function reviewDeliveryBlocker(choice: ReviewDeliveryChoice): string | null {
	if (!choice.enabled) return null
	return ReviewProgressionEnrollmentSchema.safeParse({
		enrollmentId: choice.enrollmentId,
		returnRouteRef: choice.returnRouteRef,
	}).success
		? null
		: 'Enter the enrollment and return-route references provided by the host owner. Use letters, numbers, hyphens or underscores, up to 80 characters.'
}
export const withSameSessionDelivery = (text: string) => `${text}\n\n${SAME_SESSION_DELIVERY}`

export function canResumeDevelopment(
	session:
		| { task_id: string | null; archived: boolean; status: string; execution_phase?: string | null }
		| null
		| undefined,
	canManage: boolean,
): boolean {
	return Boolean(
		canManage &&
		session?.task_id &&
		!session.archived &&
		['ready_for_input', 'interrupted'].includes(session.status) &&
		session.execution_phase !== 'implementation',
	)
}
export function developmentResumeInput(
	sessionId: string,
	ids: { messageId: string; eventId: string },
): RiptideApiInputs['sessions']['v2']['continue'] & { messageId: string; eventId: string } {
	return {
		sessionId,
		...ids,
		intent: 'send',
		executionPhase: 'implementation',
		text: 'Resume development on the accepted task in this session. Preserve its artifacts, journal and delivery restrictions; reconcile the current state before editing.',
	}
}

export type WorkEntrySession = {
	id?: string
	archived?: boolean
	execution_phase?: 'implementation' | 'review' | null
	execution_phase_at?: bigint | null
	labels?: { name: string; title: string }[] | null
}
export function latestWorkEntry<T extends WorkEntrySession>(sessions: readonly T[]): T | undefined {
	let winner: T | undefined
	for (const session of sessions) {
		const timestamp = session.execution_phase_at
		if (session.archived || timestamp == null) continue
		if (
			!winner ||
			winner.execution_phase_at == null ||
			timestamp > winner.execution_phase_at ||
			(timestamp === winner.execution_phase_at && (session.id ?? '') > (winner.id ?? ''))
		)
			winner = session
	}
	return winner
}
export function workEntryLabel(session: WorkEntrySession) {
	if (session.execution_phase_at == null) return null
	if (session.execution_phase) return { name: `rpi:${session.execution_phase}`, title: session.execution_phase }
	return session.labels?.find((label) => PlanningSkillSchema.safeParse(label.name).success) ?? null
}
export function workEntryForLabel(label: string | null | undefined): WorkEntry {
	if (label === 'rpi:implementation') return { executionPhase: 'implementation' }
	if (label === 'rpi:review' || label === 'rpi:describe-pr') return { executionPhase: 'review' }
	const planning = PlanningSkillSchema.safeParse(label)
	return planning.success ? { executionPhase: null, planningSkill: planning.data } : {}
}
export const isReviewEnrolledTask = (task: { workflow_revision?: bigint } | null | undefined) =>
	(task?.workflow_revision ?? 0n) > 0n
export const planningSkillsForWorkflow = (workflow: string) =>
	PlanningSkillSchema.options.filter((planningSkill) => {
		try {
			validateWorkEntry({ executionPhase: null, planningSkill }, workflow)
			return true
		} catch {
			return false
		}
	})

/** Prepare once per user action. Transport retries must retain this exact request. */
export async function workflowUpdateRequest(
	task: { id: string; workflow_revision?: bigint },
	input: RiptideApiInputs['tasks']['update'],
): Promise<RiptideApiInputs['tasks']['update']> {
	if (input.workflowMutation || !isReviewEnrolledTask(task) || !Object.keys(workflowPatch(input)).length) return input
	const request = { ...input }
	if (
		isReviewEnrolledTask(task) &&
		(request.workflowType !== undefined || request.autoAdvanceImplementationToPr !== undefined)
	)
		request.autoAdvanceImplementationToPr = false
	const expectedRevision = (task.workflow_revision ?? 0n).toString()
	const bytes = new TextEncoder().encode(
		canonicalReviewValue(workflowMutationPayload(task.id, expectedRevision, workflowPatch(request))),
	)
	const mutationDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return { ...request, workflowMutation: { expectedRevision, mutationDigest } }
}

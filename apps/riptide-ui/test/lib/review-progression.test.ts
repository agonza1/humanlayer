import { webcrypto, createHash } from 'node:crypto'

import {
	canonicalReviewValue,
	PlanningSkillSchema,
	validateWorkEntry,
	workEntryValues,
	workflowMutationPayload,
	type PlanningSkill,
} from '@humanlayer/riptide-api-contract/lib/review-progression'
import { describe, expect, it } from 'vitest'

import {
	canResumeDevelopment,
	developmentResumeInput,
	emptyReviewDelivery,
	latestWorkEntry,
	reviewDeliveryBlocker,
	reviewDeliveryEnrollment,
	withSameSessionDelivery,
	workEntryForLabel,
	workflowUpdateRequest,
	type WorkEntrySession,
} from '@/lib/review-progression'

describe('explicit same-session delivery', () => {
	it('defaults off and does not enroll an ordinary launch', () => {
		expect(emptyReviewDelivery().enabled).toBe(false)
		expect(reviewDeliveryEnrollment(emptyReviewDelivery())).toBeUndefined()
		expect(reviewDeliveryBlocker(emptyReviewDelivery())).toBeNull()
	})
	it('requires both safe opaque references only when selected', () => {
		expect(reviewDeliveryBlocker({ ...emptyReviewDelivery(), enabled: true })).not.toBeNull()
		const choice = { enabled: true, enrollmentId: 'personal', returnRouteRef: 'origin_1' }
		expect(reviewDeliveryEnrollment(choice)).toEqual({ enrollmentId: 'personal', returnRouteRef: 'origin_1' })
		for (const ref of ['/private/config', '--run', 'https://example.com', 'route\n'])
			expect(reviewDeliveryBlocker({ ...choice, returnRouteRef: ref })).not.toBeNull()
	})
	it('keeps the task and same-session publication/report instructions without a describe-PR footer', () => {
		const content = withSameSessionDelivery('Implement the accepted criteria')
		expect(content).toContain('Implement the accepted criteria')
		expect(content).toContain('DeliveryReportV1')
		expect(content).toContain('scopeSha256')
		expect(content).not.toContain('```\n/rpi:describe-pr\n```')
	})
})

describe('explicit development entry', () => {
	it.each<{ workflow: string; skills: PlanningSkill[] }>([
		{ workflow: 'freeform', skills: ['rpi:research'] },
		{ workflow: 'oneshot', skills: [] },
		{
			workflow: 'rpi',
			skills: ['rpi:research-questions', 'rpi:research', 'rpi:design', 'rpi:structure', 'rpi:plan'],
		},
		{
			workflow: 'outline_only',
			skills: ['rpi:research-questions', 'rpi:research', 'rpi:design', 'rpi:structure'],
		},
		{
			workflow: 'prd_tdd',
			skills: ['rpi:research-questions', 'rpi:research', 'rpi:design-prd', 'rpi:design-tdd', 'rpi:structure'],
		},
		{ workflow: 'unknown', skills: [] },
		{ workflow: '__proto__', skills: [] },
		{ workflow: 'toString', skills: [] },
	])('allows only the explicit planning skills for $workflow', ({ workflow, skills }) => {
		for (const planningSkill of PlanningSkillSchema.options) {
			const validate = () => validateWorkEntry({ executionPhase: null, planningSkill }, workflow)
			if (skills.includes(planningSkill)) expect(validate).not.toThrow()
			else expect(validate).toThrow('supported by this task workflow')
		}
	})

	it('resumes only an authorized idle nonarchived task session outside implementation', () => {
		const session = { task_id: 'task', archived: false, status: 'ready_for_input', execution_phase: 'review' }
		expect(canResumeDevelopment(session, true)).toBe(true)
		expect(canResumeDevelopment({ ...session, status: 'interrupted', execution_phase: null }, true)).toBe(true)
		expect(canResumeDevelopment(session, false)).toBe(false)
		for (const patch of [
			{ task_id: null },
			{ archived: true },
			{ execution_phase: 'implementation' },
			...['running', 'resuming', 'draft', 'lost', 'failed', 'needs_approval'].map((status) => ({ status })),
		]) {
			expect(canResumeDevelopment({ ...session, ...patch }, true)).toBe(false)
		}
		expect(canResumeDevelopment(null, true)).toBe(false)
	})
	it('uses the existing session and retained IDs for an explicit implementation send', () => {
		const input = developmentResumeInput('session', { messageId: 'message', eventId: 'event' })
		expect(input).toMatchObject({
			sessionId: 'session',
			messageId: 'message',
			eventId: 'event',
			intent: 'send',
			executionPhase: 'implementation',
		})
		expect(input).not.toHaveProperty('taskId')
		expect(input).not.toHaveProperty('planningSkill')
		expect(input.text).toContain('Preserve its artifacts, journal and delivery restrictions')
	})
	it('distinguishes omitted phase from supported explicit planning and rejects repurposed execution', () => {
		expect(workEntryValues({}, 1n)).toEqual({})
		expect(workEntryForLabel('ordinary')).toEqual({})
		expect(workEntryForLabel('rpi:implementation')).toEqual({ executionPhase: 'implementation' })
		expect(workEntryForLabel('rpi:describe-pr')).toEqual({ executionPhase: 'review' })
		const entry = workEntryForLabel('rpi:design-prd')
		expect(entry).toEqual({ executionPhase: null, planningSkill: 'rpi:design-prd' })
		expect(() => validateWorkEntry(entry, 'prd_tdd')).not.toThrow()
		expect(() => validateWorkEntry(entry, 'freeform')).toThrow('supported')
		expect(() => validateWorkEntry({ planningSkill: 'rpi:research' }, 'freeform')).toThrow('planning phase')
		expect(() =>
			validateWorkEntry(entry, 'prd_tdd', {
				execution_phase: 'review',
				labels: [{ name: 'rpi:design-prd', title: 'PRD' }],
			}),
		).toThrow('same task')
		expect(() =>
			validateWorkEntry(entry, 'prd_tdd', {
				execution_phase: null,
				labels: [{ name: 'rpi:design-prd', title: 'PRD' }],
			}),
		).not.toThrow()
		expect(workEntryValues(entry, 7n)).toEqual({
			execution_phase: null,
			execution_phase_at: 7n,
			labels: [{ name: 'rpi:design-prd', title: 'design-prd' }],
		})
	})
	it('orders explicit work entries independently of generic activity with a stable ID tie break', () => {
		const implementation: WorkEntrySession = { id: 'a', execution_phase: 'implementation', execution_phase_at: 1n }
		const review: WorkEntrySession = { id: 'b', execution_phase: 'review', execution_phase_at: 2n }
		const planning: WorkEntrySession = {
			id: 'c',
			execution_phase: null,
			execution_phase_at: 3n,
			labels: [{ name: 'rpi:design-prd', title: 'PRD' }],
		}
		const resumed: WorkEntrySession = { id: 'd', execution_phase: 'implementation', execution_phase_at: 4n }
		expect(latestWorkEntry([implementation, review, planning])).toBe(planning)
		expect(latestWorkEntry([implementation, review, planning, resumed])).toBe(resumed)
		expect(latestWorkEntry([resumed, { ...planning, id: 'z', execution_phase_at: 4n }])?.id).toBe('z')
		expect(latestWorkEntry([{ ...resumed, archived: true }, planning])).toBe(planning)
		expect(latestWorkEntry([{ id: 'old', execution_phase: null, execution_phase_at: null }])).toBeUndefined()
	})
})

describe('immutable workflow mutation requests', () => {
	it('leaves ordinary tasks unchanged and pins the exact enrolled patch and revision', async () => {
		const originalCrypto = globalThis.crypto
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
		try {
			const patch = { taskId: 'task', workflowType: 'prd_tdd' as const, autoAdvanceImplementationToPr: true }
			expect(await workflowUpdateRequest({ id: 'task', workflow_revision: 0n }, patch)).toBe(patch)
			const result = await workflowUpdateRequest({ id: 'task', workflow_revision: 7n }, patch)
			const digest = createHash('sha256')
				.update(
					canonicalReviewValue(
						workflowMutationPayload('task', '7', {
							workflowType: 'prd_tdd',
							autoAdvanceImplementationToPr: false,
						}),
					),
				)
				.digest('hex')
			expect(result).toEqual({
				...patch,
				autoAdvanceImplementationToPr: false,
				workflowMutation: { expectedRevision: '7', mutationDigest: digest },
			})
			expect(await workflowUpdateRequest({ id: 'task', workflow_revision: 8n }, result)).toBe(result)
			expect(patch.autoAdvanceImplementationToPr).toBe(true)
		} finally {
			Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
		}
	})
})

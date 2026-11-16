import { describe, expect, it } from 'vitest'

import { sessionSelectSchema } from './sessions'

const workEntry = sessionSelectSchema.pick({ execution_phase: true, execution_phase_at: true })

describe('session work-entry decoding', () => {
	it('preserves old rows without a marker', () => {
		expect(workEntry.parse({})).toEqual({ execution_phase: null, execution_phase_at: null })
	})
	it.each(['implementation', 'review', null])('round trips phase %s and its bigint timestamp', (phase) => {
		expect(workEntry.parse({ execution_phase: phase, execution_phase_at: 9n })).toEqual({
			execution_phase: phase,
			execution_phase_at: 9n,
		})
	})
	it('rejects a third execution phase', () => {
		expect(workEntry.safeParse({ execution_phase: 'planning' }).success).toBe(false)
	})
})

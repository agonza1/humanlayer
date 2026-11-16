import { describe, expect, it } from 'vitest'

import { chapterName, phaseOf } from './phases'

describe('chapter names', () => {
	it('keeps phase and explicit name precedence, then uses a generated summary or session order', () => {
		expect(
			chapterName({ labels: [{ name: 'rpi:research' }], title: 'My name', summary: 'Generated summary' }, 0),
		).toBe('Research')
		expect(chapterName({ title: 'My name', summary: 'Generated summary' }, 0)).toBe('My name')
		expect(chapterName({ title: ' ', summary: ' Generated summary ' }, 0)).toBe('Generated summary')
		expect(chapterName({ title: null, summary: null }, 2)).toBe('Session 3')
	})
	it('uses explicit implementation and review before stale labels, and deliberate planning before review', () => {
		const labels = [
			{ name: 'rpi:review', title: 'Review' },
			{ name: 'rpi:design-prd', title: 'PRD' },
		]
		expect(chapterName({ labels, execution_phase: 'implementation', execution_phase_at: 2n }, 0)).toBe('Implement')
		expect(phaseOf({ labels, execution_phase: 'review', execution_phase_at: 3n })).toBe('Review')
		expect(phaseOf({ labels, execution_phase: null, execution_phase_at: 4n })).toBe('PRD')
		expect(phaseOf({ labels, execution_phase: null, execution_phase_at: null })).toBe('Review')
	})
})

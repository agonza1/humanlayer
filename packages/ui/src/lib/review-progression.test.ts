import { describe, expect, it } from 'vitest'

import { parseReviewProgressionNote, reviewProgressionLabels } from './review-progression'

export const note = { kind: 'review_progression', version: 1, outcomeKey: 'a'.repeat(64),
	status: 'needs_decision', repository: 'fixture/project', pr: null, headSha: null,
	reportArtifact: `review-report-${'a'.repeat(64)}.md` }
describe('passive review note', () => {
	it('accepts only the closed system-event convention', () => {
		expect(parseReviewProgressionNote({ eventType: 'system', role: 'system' })).toBeNull()
		for (const content of [undefined, null, '']) expect(parseReviewProgressionNote({ eventType: 'system', role: 'system', content })).toBeNull()
		expect(parseReviewProgressionNote({ eventType: 'system', content: JSON.stringify(note) })).toBeNull()
		expect(parseReviewProgressionNote({ eventType: 'system', role: undefined, content: JSON.stringify(note) })).toBeNull()
		expect(parseReviewProgressionNote({ eventType: 'system', role: 'system', content: JSON.stringify(note) })).toEqual(note)
		for (const patch of [{ version: 2 }, { command: 'continue' }, { reportArtifact: '../secret.md' },
			{ status: 'ready_for_human_approval' }, { outcomeKey: 'b'.repeat(64) }]) {
			expect(parseReviewProgressionNote({ eventType: 'system', role: 'system', content: JSON.stringify({ ...note, ...patch }) })).toBeNull()
		}
		for (const role of ['user', 'assistant']) expect(parseReviewProgressionNote({ eventType: 'system', role, content: JSON.stringify(note) })).toBeNull()
		expect(parseReviewProgressionNote({ eventType: 'message', role: 'system', content: JSON.stringify(note) })).toBeNull()
	})
	it('keeps distinct merge outcomes passive and pinned to one reviewed head', () => {
		for (const status of ['merged', 'failed', 'declined', 'invalidated', 'merge_unknown', 'observed_external_merge'] as const) {
			const result = { ...note, status, pr: 7, headSha: 'b'.repeat(40) }
			expect(parseReviewProgressionNote({ eventType: 'system', role: 'system', content: JSON.stringify(result) })).toEqual(result)
			expect(reviewProgressionLabels[status]).not.toContain('_')
			expect(parseReviewProgressionNote({ eventType: 'system', role: 'system', content: JSON.stringify({ ...result, headSha: null }) })).toBeNull()
		}
	})
})

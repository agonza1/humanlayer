import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReviewProgressionNoteContent } from './review-progression-note'

describe('review note renderer', () => {
	it('shows evidence and limitations without execution controls', () => {
		render(<ReviewProgressionNoteContent note={{ kind: 'review_progression', version: 1, outcomeKey: 'a'.repeat(64),
			status: 'needs_decision', repository: 'fixture/project', pr: null, headSha: null,
			reportArtifact: `review-report-${'a'.repeat(64)}.md` }} />)
		expect(screen.getByLabelText('Review update').textContent).toContain('Review needs your attention')
		expect(screen.getByText(/does not start the agent/)).toBeDefined()
		expect(screen.queryByRole('button')).toBeNull()
	})
	it('distinguishes observed merges, uncertainty and refusal without action controls', () => {
		for (const [status, label] of [['observed_external_merge', 'Pull request merge observed on GitHub'], ['merge_unknown', 'Could not confirm the merge'], ['declined', 'Merge declined']] as const) {
			cleanup()
			render(<ReviewProgressionNoteContent note={{ kind: 'review_progression', version: 1, outcomeKey: 'b'.repeat(64),
				status, repository: 'fixture/project', pr: 7, headSha: 'a'.repeat(40), reportArtifact: `review-report-${'b'.repeat(64)}.md` }} />)
			expect(screen.getByLabelText('Review update').textContent).toContain(label)
			expect(screen.queryByRole('button')).toBeNull()
		}
	})
})

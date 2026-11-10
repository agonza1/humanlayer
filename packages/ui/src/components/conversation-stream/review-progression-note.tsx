import { reviewProgressionLabels, type ReviewProgressionNote } from '../../lib/review-progression'

export function ReviewProgressionNoteContent({ note }: { note: ReviewProgressionNote }) {
	return (
		<aside aria-label="Review update" className="my-2 rounded border border-border px-4 py-3 text-sm">
			<p className="font-medium">{reviewProgressionLabels[note.status]}</p>
			<p className="text-muted-foreground">
				{note.repository}{note.pr === null ? '' : ` #${note.pr}`}{note.headSha ? ` at ${note.headSha.slice(0, 12)}` : ''}
			</p>
			<p>Open <code>{note.reportArtifact}</code> for evidence and delivery limitations.</p>
			<p className="text-muted-foreground">This update does not start the agent or approve a merge or deployment.</p>
		</aside>
	)
}

import { workEntryLabel, type WorkEntrySession } from '@/lib/review-progression'
import { sessionName } from '@/minimalist/lib/session-name'

const PHASE_NAMES = {
	'rpi:research-questions': 'Questions',
	'rpi:research': 'Research',
	'rpi:design': 'Design',
	'rpi:design-prd': 'PRD',
	'rpi:design-tdd': 'TDD',
	'rpi:structure': 'Outline',
	'rpi:plan': 'Plan',
	'rpi:worktree-setup': 'Worktree',
	'rpi:implementation': 'Implement',
	'rpi:describe-pr': 'PR',
	'rpi:review': 'Review',
} as const

/** The RPI phase a session belongs to, from its labels; null for freeform sessions. */
export function phaseOf(session: { labels?: unknown } & Omit<WorkEntrySession, 'labels'>): string | null {
	if (session.execution_phase_at != null) {
		const label = workEntryLabel({ ...session, labels: Array.isArray(session.labels) ? session.labels : null })
		return label ? (PHASE_NAMES[label.name as keyof typeof PHASE_NAMES] ?? null) : null
	}
	if (!Array.isArray(session.labels)) return null
	for (const label of session.labels) {
		const name = (label as { name?: unknown }).name
		if (typeof name === 'string' && name in PHASE_NAMES) return PHASE_NAMES[name as keyof typeof PHASE_NAMES]
	}
	return null
}

/** The chapter name shown in the title bar: phase, session name/summary, then its order. */
export function chapterName(
	session: { labels?: unknown; title?: string | null; summary?: string | null } & Omit<WorkEntrySession, 'labels'>,
	index: number,
): string {
	return phaseOf(session) ?? sessionName(session, `Session ${index + 1}`)
}

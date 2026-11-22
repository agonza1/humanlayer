import { SESSION_STATUSES, type SessionStatus } from './effect/session/session-status'

export const BOARD_COLUMNS = [
	{ id: 'todo', title: 'To do', description: 'Tasks waiting to start' },
	{ id: 'research-design', title: 'Research and design', description: 'Explore needs and options' },
	{ id: 'planning', title: 'Planning', description: 'Plan how to do the work' },
	{ id: 'implementation', title: 'Implementation', description: 'Build and verify changes' },
	{ id: 'in-review', title: 'In review', description: 'Check results and pull requests' },
] as const

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id']
export type BoardStatus = SessionStatus | 'not_started'

type WorkflowLabel = { name: string; title: string }

// In workflow order, lowest to highest. Keep in step with RPI_LABELS in packages/ui.
export const LABEL_TO_COLUMN = {
	'rpi:todo': 'todo',
	'rpi:research-questions': 'research-design',
	'rpi:research': 'research-design',
	'rpi:design': 'research-design',
	'rpi:design-prd': 'research-design',
	'rpi:design-tdd': 'research-design',
	'rpi:structure': 'planning',
	'rpi:plan': 'planning',
	'rpi:worktree-setup': 'implementation',
	'rpi:implementation': 'implementation',
	'rpi:describe-pr': 'in-review',
	'rpi:review': 'in-review',
} as const

type BoardLabelName = keyof typeof LABEL_TO_COLUMN
const LABEL_ORDER = Object.keys(LABEL_TO_COLUMN)
const TODO_LABEL = { name: 'rpi:todo', title: 'todo' }
const IMPLEMENTATION_LABEL = { name: 'rpi:implementation', title: 'implementation' }
const REVIEW_LABEL = { name: 'rpi:review', title: 'review' }

type RecordTime = bigint | number | string | null | undefined

export interface BoardTaskInput {
	is_draft?: boolean | null
	created_at?: RecordTime
	updated_at?: RecordTime
}

export interface BoardSessionInput {
	id?: string
	archived: boolean
	labels: readonly WorkflowLabel[] | null
	last_activity_at: RecordTime
	created_at?: RecordTime
	updated_at?: RecordTime
	status?: string | null
}

const LIVE_STATUS_PRIORITY: Partial<Record<SessionStatus, number>> = {
	ready_for_launch: 1,
	waiting_for_workspace: 2,
	launching: 3,
	resuming: 3,
	waiting_for_usage_limit: 4,
	interrupt_requested: 5,
	running: 6,
	needs_approval: 7,
}
const KNOWN_STATUSES = new Set<string>(SESSION_STATUSES)

function isSessionStatus(status: string | null | undefined): status is SessionStatus {
	return typeof status === 'string' && KNOWN_STATUSES.has(status)
}

function livePriority(status: string | null | undefined) {
	return isSessionStatus(status) ? (LIVE_STATUS_PRIORITY[status] ?? 0) : 0
}

function sessionActivity(session: BoardSessionInput) {
	return Number(session.last_activity_at ?? 0)
}

function isNewerSession(session: BoardSessionInput, current: BoardSessionInput) {
	const difference = sessionActivity(session) - sessionActivity(current)
	return difference > 0 || (difference === 0 && (session.id ?? '') > (current.id ?? ''))
}

function mostRecentStartedSession(sessions: readonly BoardSessionInput[]) {
	let latest: BoardSessionInput | undefined
	for (const session of sessions) {
		if (!session.status || session.status === 'draft') continue
		if (!latest || isNewerSession(session, latest)) latest = session
	}
	return latest
}

interface StageAssignment {
	columnId: BoardColumnId
	workflowLabel: WorkflowLabel
	/** Activity of the session that set the phase, for the standard board's sort. */
	stageActivityMs: number
}

function assignStage(
	sessions: readonly BoardSessionInput[],
	latest = mostRecentStartedSession(sessions),
): StageAssignment {
	let winner: BoardSessionInput | undefined
	for (const session of sessions) {
		if (!session.labels?.length) continue
		if (!winner || isNewerSession(session, winner)) winner = session
	}

	let topLabel: WorkflowLabel | undefined
	let topRank = -1
	for (const label of winner?.labels ?? []) {
		const rank = LABEL_ORDER.indexOf(label.name)
		if (rank > topRank) {
			topLabel = label
			topRank = rank
		}
	}

	if (!topLabel || !winner) {
		if (!latest) return { columnId: 'todo', workflowLabel: TODO_LABEL, stageActivityMs: -1 }

		// An idle turn is ready to inspect. It can coexist with another
		// session that still needs to run or needs attention.
		const review =
			latest.status === 'ready_for_input' &&
			!sessions.some((session) => livePriority(session.status) > 0 || session.status === 'lost')
		return {
			columnId: review ? 'in-review' : 'implementation',
			workflowLabel: review ? REVIEW_LABEL : IMPLEMENTATION_LABEL,
			stageActivityMs: sessionActivity(latest),
		}
	}

	const stageActivityMs = sessionActivity(winner)
	if (topLabel.name === 'rpi:implementation' && winner.status === 'ready_for_input') {
		const previouslyInReview = sessions.some(
			(session) =>
				session.status !== 'draft' &&
				sessionActivity(session) < stageActivityMs &&
				session.labels?.some((label) => label.name === 'rpi:describe-pr' || label.name === 'rpi:review'),
		)
		const allIdle = sessions.every((session) => session.status === 'ready_for_input' || session.status === 'draft')
		if (previouslyInReview && allIdle) {
			return { columnId: 'in-review', workflowLabel: REVIEW_LABEL, stageActivityMs }
		}
	}

	return { columnId: LABEL_TO_COLUMN[topLabel.name as BoardLabelName], workflowLabel: topLabel, stageActivityMs }
}

export function getBoardColumn(sessions: readonly BoardSessionInput[]): BoardColumnId {
	return assignStage(sessions.filter((session) => !session.archived)).columnId
}

/** Shared by both board views and the CLI. The phase and current session state are independent. */
export function describeBoardTask(task: BoardTaskInput, sessions: readonly BoardSessionInput[]) {
	const activeSessions = sessions.filter((session) => !session.archived)
	const latest = mostRecentStartedSession(activeSessions)
	let status: BoardStatus = task.is_draft ? 'draft' : 'not_started'
	if (isSessionStatus(latest?.status)) status = latest.status

	let priority = 0
	let updatedAt = Math.max(Number(task.created_at ?? 0), Number(task.updated_at ?? 0))
	for (const session of activeSessions) {
		updatedAt = Math.max(
			updatedAt,
			sessionActivity(session),
			Number(session.created_at ?? 0),
			Number(session.updated_at ?? 0),
		)
		if (!isSessionStatus(session.status)) continue
		const rank = livePriority(session.status)
		if (rank > priority) {
			status = session.status
			priority = rank
		}
	}

	return { ...assignStage(activeSessions, latest), status, lastUpdatedAtMs: updatedAt > 0 ? updatedAt : null }
}

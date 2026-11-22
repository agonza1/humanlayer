import { SESSION_STATUSES, type SessionStatus } from './effect/session/session-status'
import { AutomaticDeliverySchema, type AutomaticDelivery, type DeliveryAlertReceipt } from './zod/automatic-delivery'
import { decodeImplementationReconciliation, IMPLEMENTATION_BLOCKERS } from './zod/implementation-reconciliation'

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
type BlockerAlert = NonNullable<AutomaticDelivery['blockerAlert']>
type BoardBlockerAlert = {
	slack: DeliveryAlertReceipt['status']
	origin: DeliveryAlertReceipt['status']
	slackRoute?: BlockerAlert['slackRoute']
}

export type BoardDelivery =
	| { status: 'queued' | 'running'; sessionId: string; deadlineAt?: number }
	| { status: 'verifying'; deadlineAt: number }
	| { status: 'review' }
	| {
			status: 'blocked'
			reason: string
			publication?: boolean
			stage?: 'implementation' | 'in-review'
			alert?: BoardBlockerAlert
	  }

export interface BoardTaskInput {
	automatic_delivery?: unknown
	implementation_reconciliation?: unknown
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

function describeBlockerAlert(receipts: BlockerAlert | undefined): BoardBlockerAlert | undefined {
	if (!receipts) return undefined
	const alert: BoardBlockerAlert = { slack: receipts.slack.status, origin: receipts.origin.status }
	if (receipts.slackRoute) alert.slackRoute = receipts.slackRoute
	return alert
}

function describeDelivery(
	task: BoardTaskInput,
	sessions: readonly BoardSessionInput[],
	latest?: BoardSessionInput,
): BoardDelivery | null {
	let rawDelivery = task.automatic_delivery
	if (typeof rawDelivery === 'string') {
		try {
			rawDelivery = JSON.parse(rawDelivery)
		} catch {
			rawDelivery = null
		}
	}
	const delivery = AutomaticDeliverySchema.safeParse(rawDelivery).data
	const alert = describeBlockerAlert(delivery?.blockerAlert)
	if (delivery?.phase === 'attention' && delivery.attention) {
		return {
			status: 'blocked',
			reason: delivery.attention,
			publication: delivery.attentionDuringPublication,
			alert,
		}
	}

	// Automatic delivery pins the current successor. Older stock auto-advance
	// sessions carry the Describe PR label on the original task.
	const handoff =
		delivery?.phase === 'pr'
			? sessions.find((session) => session.id === delivery.managedSessionId)
			: delivery == null && latest?.labels?.some((label) => label.name === 'rpi:describe-pr')
				? latest
				: undefined
	if (!handoff?.id) {
		return delivery?.phase === 'pr'
			? {
					status: 'blocked',
					publication: true,
					reason: 'Describe PR session is missing. Check the task before resuming.',
				}
			: null
	}
	switch (handoff.status) {
		case 'ready_for_launch':
		case 'waiting_for_workspace':
			return { status: 'queued', sessionId: handoff.id }
		case 'launching':
		case 'resuming':
		case 'running':
			return { status: 'running', sessionId: handoff.id }
		case 'needs_approval':
			return {
				status: 'blocked',
				publication: true,
				reason: 'Describe PR needs approval. Open the session to review the request.',
				alert,
			}
		case 'waiting_for_usage_limit':
			return {
				status: 'blocked',
				publication: true,
				reason: 'Describe PR reached its usage limit. Check the session before resuming.',
				alert,
			}
		case 'failed':
		case 'lost':
		case 'interrupted':
			return {
				status: 'blocked',
				publication: true,
				reason: 'Describe PR stopped before delivery was verified. Check the session before resuming.',
			}
		default:
			return null
	}
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

	const stage = assignStage(activeSessions, latest)
	const stockDelivery = describeDelivery(task, activeSessions, latest)
	const reconciliation = decodeImplementationReconciliation(task.implementation_reconciliation)
	const decision = reconciliation?.decision
	let delivery: BoardDelivery | null = stockDelivery
	const pendingBlocker =
		status === 'needs_approval' ||
		status === 'waiting_for_usage_limit' ||
		status === 'ready_for_launch' ||
		status === 'waiting_for_workspace'
	if (
		decision?.status === 'blocked' &&
		(priority === 0 || pendingBlocker || decision.reason === 'writer-unknown') &&
		stockDelivery?.status !== 'blocked'
	) {
		delivery = {
			status: 'blocked',
			reason: IMPLEMENTATION_BLOCKERS[decision.reason],
			stage: decision.stage,
			alert: describeBlockerAlert(reconciliation?.blockerAlert),
		}
	} else if (
		decision?.status === 'waiting-publication' &&
		(!stockDelivery || (stockDelivery.status === 'queued' && stockDelivery.sessionId === decision.sessionId))
	) {
		const session = activeSessions.find((entry) => entry.id === decision.sessionId)
		if (session && ['ready_for_launch', 'waiting_for_workspace'].includes(session.status ?? ''))
			delivery = { status: 'queued', sessionId: decision.sessionId, deadlineAt: decision.deadlineAt }
	} else if (
		priority === 0 &&
		(decision?.status === 'review' || decision?.status === 'verifying') &&
		!stockDelivery
	) {
		delivery = decision.status === 'review' ? decision : { status: 'verifying', deadlineAt: decision.deadlineAt }
	}
	if (delivery?.status === 'blocked' && delivery.stage) stage.columnId = delivery.stage
	else if (delivery?.status === 'review') stage.columnId = 'in-review'
	else if (delivery && (delivery.status !== 'blocked' || delivery.publication)) stage.columnId = 'implementation'
	if (
		stage.columnId === 'in-review' &&
		(delivery?.status === 'review' || (delivery?.status === 'blocked' && delivery.stage === 'in-review'))
	)
		stage.workflowLabel = REVIEW_LABEL
	return { ...stage, status, lastUpdatedAtMs: updatedAt > 0 ? updatedAt : null, delivery }
}

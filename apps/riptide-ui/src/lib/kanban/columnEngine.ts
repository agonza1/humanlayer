import {
	BOARD_COLUMNS,
	type BoardColumnId,
	type BoardSessionInput,
	type BoardTaskInput,
	describeBoardTask,
	getBoardColumn,
} from '@humanlayer/schemas/task-board'
import type { KanbanCardModel as KanbanCard, KanbanColumns } from '@humanlayer/ui/components/kanban'

import { activityMinute } from '@/lib/activitySorting'

export { BOARD_COLUMNS as KANBAN_COLUMN_DEFS, LABEL_TO_COLUMN } from '@humanlayer/schemas/task-board'
export type ColumnId = BoardColumnId

export interface KanbanSessionInput extends BoardSessionInput {
	last_activity_at: bigint | null
	resource_owner_user_id?: string | null
}

export function assignColumn(_task: { is_draft?: boolean }, sessions: KanbanSessionInput[]): ColumnId {
	return getBoardColumn(sessions)
}

/** A task plus the projected data the engine needs to build its card. */
export interface KanbanTaskInput extends BoardTaskInput {
	id: string
	name: string
	created_at?: bigint | null
	resource_owner_user_id: string | null
	sessions: KanbanSessionInput[]
}

/** Owner display info resolved per-user by the wired hook. */
export interface KanbanOwnerInfo {
	initials: string
	avatarUrl?: string
}

function getTaskOwnerIds(task: KanbanTaskInput): string[] {
	const ownerIds: string[] = []
	const seen = new Set<string>()

	const addOwner = (userId: string | null | undefined) => {
		if (!userId || seen.has(userId)) return
		seen.add(userId)
		ownerIds.push(userId)
	}

	addOwner(task.resource_owner_user_id)
	for (const session of task.sessions) {
		if (session.archived) continue
		addOwner(session.resource_owner_user_id)
	}

	return ownerIds
}

export interface BuildKanbanColumnsInput {
	tasks: KanbanTaskInput[]
	/** Resolve owner display info from a task's `resource_owner_user_id`. */
	resolveOwner: (userId: string | null) => KanbanOwnerInfo
	/**
	 * Unread session ids (from the shared unread store). A card is marked unread
	 * when any of its non-archived sessions is in this set — same calculation as
	 * the left-nav sidebar.
	 */
	unreadSessionIds?: Set<string>
}

interface CardWithActivity {
	card: KanbanCard
	activity: number
	createdAt: bigint
}

/**
 * Build the ordered kanban columns from tasks + their sessions.
 *
 * Within each column, cards are sorted by the winning session's activity
 * minute, then task creation time, both descending.
 */
export function buildKanbanColumns(input: BuildKanbanColumnsInput): KanbanColumns {
	const unreadSessionIds = input.unreadSessionIds ?? new Set<string>()
	const buckets = new Map<ColumnId, CardWithActivity[]>()
	for (const def of BOARD_COLUMNS) {
		buckets.set(def.id, [])
	}

	for (const task of input.tasks) {
		const { columnId, workflowLabel, stageActivityMs, status, lastUpdatedAtMs, delivery, attention } =
			describeBoardTask(task, task.sessions)
		const owner = input.resolveOwner(task.resource_owner_user_id)
		const owners = getTaskOwnerIds(task).map((userId) => ({ id: userId, ...input.resolveOwner(userId) }))

		// Unread — true when any non-archived session is unread, mirroring the
		// left-nav sidebar's task-level propagation (`sessions.some(isUnread)`).
		const isUnread = task.sessions.some(
			(session) => !session.archived && session.id !== undefined && unreadSessionIds.has(session.id),
		)

		buckets.get(columnId)?.push({
			activity: stageActivityMs,
			createdAt: task.created_at ?? 0n,
			card: {
				id: task.id,
				title: task.name,
				updatedAtMs: lastUpdatedAtMs ?? undefined,
				ownerInitials: owner.initials,
				ownerAvatarUrl: owner.avatarUrl,
				owners,
				isDraft: task.is_draft ?? false,
				workflowLabel,
				status,
				delivery,
				attention,
				isUnread,
			},
		})
	}

	return BOARD_COLUMNS.map((def) => {
		const cards = (buckets.get(def.id) ?? [])
			.sort((a, b) => {
				const activityDifference = activityMinute(b.activity) - activityMinute(a.activity)
				if (activityDifference !== 0) return activityDifference
				if (b.createdAt === a.createdAt) return 0
				return b.createdAt > a.createdAt ? 1 : -1
			})
			.map((entry) => entry.card)

		return { ...def, cards }
	})
}

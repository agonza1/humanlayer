import { BOARD_COLUMNS, type BoardStatus, describeBoardTask } from '@humanlayer/schemas/task-board'
import { boardStatusLabel, formatBoardUpdateTime } from '@humanlayer/ui/lib/task-board'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useMinuteClock } from '@/hooks/useMinuteClock'
import { WiredUserAvatar } from '@/minimalist/components/Avatar'
import { Segmented } from '@/minimalist/components/SettingsControls'
import { type TaskRow, type TaskTreeScope, useTaskTree } from '@/minimalist/lib/data'
import { useUi } from '@/minimalist/lib/ui-state'
import { useTaskUnread } from '@/minimalist/lib/use-unread'

const SCOPES: Array<{ value: TaskTreeScope; label: string }> = [
	{ value: 'mine', label: 'Mine' },
	{ value: 'everyone', label: 'Everyone' },
]

type BoardRow = {
	row: TaskRow
	status: BoardStatus
	lastUpdatedAtMs: number | null
}

/** Tasks grouped by workflow phase. */
export function BoardPage() {
	const [scope, setScope] = useState<TaskTreeScope>('everyone')
	const { recent: rows, isReady } = useTaskTree(false, scope)
	const nowMs = useMinuteClock()
	const columns = BOARD_COLUMNS.map((column) => ({ ...column, rows: [] as BoardRow[] }))
	const byId = new Map(columns.map((column) => [column.id, column]))
	for (const row of rows) {
		const { columnId, status, lastUpdatedAtMs } = describeBoardTask(row.task, row.sessions)
		byId.get(columnId)?.rows.push({ row, status, lastUpdatedAtMs })
	}
	return (
		<main className="main board">
			<div className="titlebar">
				<span className="title">Board</span>
				<span className="sp" />
				<Segmented label="Show" value={scope} options={SCOPES} onChange={setScope} />
			</div>
			{isReady && rows.length === 0 ? (
				<div className="hero">
					<h1 className="status">{scope === 'mine' ? 'No tasks of yours yet' : 'No tasks yet'}</h1>
					<Link className="btn" to="/">
						New task
					</Link>
				</div>
			) : (
				<div className="board-columns">
					{columns.map((column) => (
						<section key={column.id} className="board-column" aria-label={column.title}>
							<div className="section">
								{column.title}
								<span className="meta">{column.rows.length}</span>
							</div>
							<p className="board-column-description">{column.description}</p>
							<div className="board-cards">
								{column.rows.map((card) => (
									<BoardCard key={card.row.task.id} {...card} nowMs={nowMs} />
								))}
							</div>
						</section>
					))}
				</div>
			)}
		</main>
	)
}

function BoardCard({ row, status, lastUpdatedAtMs, nowMs }: BoardRow & { nowMs: number }) {
	const unread = useTaskUnread(row.sessions)
	const setupFailed = status === 'waiting_for_workspace' && row.workspaceSetupFailed
	const updated = lastUpdatedAtMs === null ? null : formatBoardUpdateTime(lastUpdatedAtMs, nowMs)
	const { closeSidebarOnNarrow } = useUi()
	return (
		<Link
			to="/tasks/$taskId"
			params={{ taskId: row.task.id }}
			onClick={closeSidebarOnNarrow}
			className={`board-card${unread ? ' unread' : ''}`}
			title={row.task.name}
		>
			<span className="board-card-name">{row.task.name}</span>
			<span className="board-card-meta">
				<span className="ell">{row.projectName}</span>
				<span className="sp" />
				<WiredUserAvatar userId={row.task.resource_owner_user_id} size={18} />
				{unread && <span className="dot" role="img" aria-label="Unread" />}
			</span>
			<span className="board-card-status">
				<span data-status={setupFailed ? 'failed' : status}>
					{setupFailed ? 'Workspace setup failed' : boardStatusLabel(status)}
				</span>
				{updated && (
					<time dateTime={updated.dateTime} title={updated.full}>
						Updated {updated.label}
					</time>
				)}
			</span>
		</Link>
	)
}

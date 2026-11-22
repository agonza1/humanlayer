import type { SyncInput, WhereExpression } from '@humanlayer/riptide-api-contract/api/sync/shared-schemas'
import {
	BOARD_COLUMNS,
	type BoardSessionInput,
	type BoardTaskInput,
	describeBoardTask,
} from '@humanlayer/schemas/task-board'
import { type Command, InvalidArgumentError } from 'commander'
import { z } from 'zod'

import { createLazyClient } from '../api/lazy-client'
import { type EnvironmentName, resolveEnvironmentConfig } from '../lib/macros'

const SYNC_PAGE_SIZE = 250
const TASK_ID_BATCH_SIZE = 100

type TaskRow = BoardTaskInput & { id: string; name: string; project_id: string | null }
type SessionRow = BoardSessionInput & { id: string; task_id: string | null }
type ReadRows<Row> = (input: SyncInput) => Promise<{ rows: Row[] }>
type BoardSync = { tasks: ReadRows<TaskRow>; sessions: ReadRows<SessionRow> }

function filter(field: string, operator: string, value: unknown): WhereExpression {
	return { type: 'comparison', field: [field], operator, value }
}

async function* readPages<Row extends { id: string }>(read: ReadRows<Row>, conditions: WhereExpression[]) {
	let lastId: string | undefined
	while (true) {
		const { rows } = await read({
			where: { type: 'and', conditions: lastId ? [...conditions, filter('id', 'gt', lastId)] : conditions },
			sorts: [{ field: ['id'], direction: 'asc', nulls: 'last' }],
			limit: SYNC_PAGE_SIZE,
		})
		yield* rows
		const last = rows.at(-1)
		if (!last || rows.length < SYNC_PAGE_SIZE) return
		lastId = last.id
	}
}

export async function readBoard(sync: BoardSync, appOrigin: string, projectId?: string) {
	const taskFilters: WhereExpression[] = [filter('archived', 'eq', false)]
	if (projectId) taskFilters.push(filter('project_id', 'eq', projectId))
	const tasks: TaskRow[] = []
	for await (const task of readPages(sync.tasks, taskFilters)) {
		// Project drafts are board cards. Composer drafts without a project are private to the composer.
		if (!task.is_draft || task.project_id) tasks.push(task)
	}

	const sessionsByTaskId = new Map<string, BoardSessionInput[]>()
	for (let offset = 0; offset < tasks.length; offset += TASK_ID_BATCH_SIZE) {
		const taskIds = tasks.slice(offset, offset + TASK_ID_BATCH_SIZE).map((task) => task.id)
		for await (const session of readPages(sync.sessions, [
			filter('archived', 'eq', false),
			filter('task_id', 'in', taskIds),
		])) {
			if (!session.task_id) continue
			const grouped = sessionsByTaskId.get(session.task_id) ?? []
			grouped.push(session)
			sessionsByTaskId.set(session.task_id, grouped)
		}
	}

	const cards = tasks.map((task) => {
		const state = describeBoardTask(task, sessionsByTaskId.get(task.id) ?? [])
		return {
			columnId: state.columnId,
			id: task.id,
			title: task.name,
			projectId: task.project_id,
			status: state.status,
			delivery: state.delivery,
			workflowLabel: state.workflowLabel,
			lastUpdatedAt: state.lastUpdatedAtMs === null ? null : new Date(state.lastUpdatedAtMs).toISOString(),
			url: new URL(`/tasks/${task.id}`, appOrigin).href,
		}
	})
	cards.sort((a, b) => (b.lastUpdatedAt ?? '').localeCompare(a.lastUpdatedAt ?? ''))

	return {
		columns: BOARD_COLUMNS.map((column) => ({
			...column,
			cards: cards.filter((card) => card.columnId === column.id),
		})),
	}
}

export function registerBoardCommand(program: Command, getEnv: () => EnvironmentName) {
	const getClient = createLazyClient(getEnv)
	const command = program
		.command('board')
		.description('Print the active task board as JSON')
		.option('--project-id <id>', 'Show tasks for one project', (id) => {
			if (!z.uuid().safeParse(id).success) throw new InvalidArgumentError('Expected a project UUID')
			return id
		})

	command.action(async ({ projectId }: { projectId?: string }) => {
		try {
			const client = await getClient()
			const { appOrigin } = resolveEnvironmentConfig(getEnv())
			const board = await readBoard(client.sync, appOrigin, projectId)
			console.log(JSON.stringify(board))
		} catch (error) {
			command.error(`Could not read the board: ${error instanceof Error ? error.message : String(error)}`)
		}
	})
}

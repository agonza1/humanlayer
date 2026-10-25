import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { TaskNativeExecutionSchema } from '@humanlayer/riptide-api-contract/api/tasks/update'
import type { Command } from 'commander'
import z from 'zod/v4'

export const NativeBridgeConfigSchema = z
	.object({
		apiOrigin: z.url().refine((value) => {
			const url = new URL(value)
			return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
		}, 'Use an HTTP loopback API origin'),
		sessionFile: z.string().refine(isAbsolute),
		taskId: z.uuid(),
		repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
		directory: z.string().refine(isAbsolute),
	})
	.strict()
export const NativeBridgeUpdateSchema = z
	.object({
		execution: TaskNativeExecutionSchema,
		artifacts: z
			.array(
				z
					.object({
						fileName: z.enum([
							'native-request.md',
							'native-coder-result.md',
							'native-qa-request.md',
							'native-qa-result.md',
						]),
						content: z.string().min(1),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()
type Update = z.infer<typeof NativeBridgeUpdateSchema>
export interface NativeBridgeAdapter {
	identity(): Promise<string>
	task(): Promise<{ ownerId: string; archived: boolean; draft: boolean; nativeExecution: unknown }>
	artifact(fileName: string, content: string): Promise<void>
	project(execution: Update['execution']): Promise<void>
}

export function nativeExecutionReceipt(execution: Update['execution']) {
	const lines = [
		'# Native Codex execution',
		'',
		'Snapshot of this handoff; later task updates may supersede it.',
		'',
		'Mode: Main-mediated pilot',
		'Stage: ' + execution.stage,
		'Repository: ' + execution.repository,
		'Directory: `' + execution.directory + '`',
		'',
		'Coder chat: [Open in Codex](codex://threads/' + execution.coderThreadId + ')',
		'Coder thread ID: `' + execution.coderThreadId + '`',
	]
	if (execution.qaThreadId)
		lines.push(
			'QA chat: [Open in Codex](codex://threads/' + execution.qaThreadId + ')',
			'QA thread ID: `' + execution.qaThreadId + '`',
		)
	if (execution.headSha) lines.push('Reviewed implementation commit: `' + execution.headSha + '`')
	if (execution.reason) lines.push('', 'Blocked: ' + execution.reason)
	lines.push(
		'',
		'Main creates and reads the native chats, records their requests/results as task artifacts, and confirms handoffs. This command synchronizes records; it does not dispatch or monitor agents.',
		'',
	)
	return lines.join('\n')
}

/** Each named artifact and final task projection is idempotent; replay the same update after failure. */
export async function syncNativeExecution(rawConfig: unknown, rawUpdate: unknown, adapter: NativeBridgeAdapter) {
	const config = NativeBridgeConfigSchema.parse(rawConfig)
	const update = NativeBridgeUpdateSchema.parse(rawUpdate)
	const execution = {
		...update.execution,
		coderThreadId: update.execution.coderThreadId.toLowerCase(),
		qaThreadId: update.execution.qaThreadId?.toLowerCase(),
	}
	if (execution.repository !== config.repository || execution.directory !== config.directory)
		throw new Error('Native execution differs from the configured repository or directory')
	const [userId, task] = await Promise.all([adapter.identity(), adapter.task()])
	if (task.ownerId !== userId) throw new Error('Only the task owner can record native execution')
	if (task.archived || task.draft) throw new Error('Native execution requires an active launched task')
	if (task.nativeExecution !== null && task.nativeExecution !== undefined) {
		const previous = TaskNativeExecutionSchema.parse(task.nativeExecution)
		if (
			previous.repository !== config.repository ||
			previous.directory !== config.directory ||
			previous.coderThreadId.toLowerCase() !== execution.coderThreadId
		)
			throw new Error('Task is already bound to another native execution')
		if (previous.qaThreadId && previous.qaThreadId.toLowerCase() !== execution.qaThreadId)
			throw new Error('Task is already bound to another QA chat')
		if (previous.headSha && previous.headSha !== execution.headSha)
			throw new Error('Reviewed implementation commit cannot change during this pilot')
		const order = { implementation: 0, in_review: 1, blocked: 2 }
		if (order[execution.stage] < order[previous.stage])
			throw new Error('Native execution cannot move backwards; blocked pilots require a new task')
	}
	for (const artifact of update.artifacts) await adapter.artifact(artifact.fileName, artifact.content)
	await adapter.artifact('native-execution.md', nativeExecutionReceipt(execution))
	// Project the new board phase only after its request/result evidence is stored.
	await adapter.project(execution)
	return {
		taskId: config.taskId,
		stage: execution.stage,
		coderThreadId: execution.coderThreadId,
		qaThreadId: execution.qaThreadId,
	}
}

export async function runNativeBridge(configPath: string, updatePath: string) {
	const config = NativeBridgeConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
	const update = NativeBridgeUpdateSchema.parse(JSON.parse(await readFile(updatePath, 'utf8')))
	const { localApiClient } = await import('./local-delivery/runtime')
	const api = await localApiClient(config)
	return syncNativeExecution(config, update, {
		identity: async () => (await api.auth.user.info({})).userId,
		task: async () => {
			for (let offset = 0; ; offset += 100) {
				const { rows } = await api.tasks.list({ offset, limit: 100 })
				const task = rows.find((row) => row.id === config.taskId)
				if (task)
					return {
						ownerId: task.resource_owner_user_id,
						archived: task.archived,
						draft: task.is_draft,
						nativeExecution: task.native_execution,
					}
				if (rows.length < 100) throw new Error('Configured task is not accessible')
			}
		},
		artifact: async (fileName, content) => {
			await api.uploads.upsertText({ taskId: config.taskId, fileName, content })
		},
		project: async (nativeExecution) => {
			await api.tasks.update({ taskId: config.taskId, nativeExecution })
		},
	})
}
export function registerNativeBridge(program: Command) {
	program
		.command('native-bridge')
		.description('Record verified Main-mediated native Codex handoffs in HumanLayer')
		.requiredOption('--config <path>', 'Private task and repository binding configuration')
		.requiredOption('--update <path>', 'Verified native chat metadata and request/result artifacts')
		.action(async (options: { config: string; update: string }) => {
			console.log(JSON.stringify(await runNativeBridge(options.config, options.update)))
		})
}

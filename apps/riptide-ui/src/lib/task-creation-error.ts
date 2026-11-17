import { TaskSlugConflictDataSchema } from '@humanlayer/riptide-api-contract/api/tasks/create'
import { TaskLaunchConflictDataSchema } from '@humanlayer/riptide-api-contract/api/tasks/launch-draft'
import { isDefinedError, ORPCError } from '@orpc/client'

import type { ResolutionHint } from '@/hooks/stores/newTaskFormStore'
import { getTicketLookupError } from '@/lib/ticket-lookup-error'

export interface TaskCreationErrorDetails {
	errorMessage: string
	resolutionHint?: ResolutionHint
}

export class TaskPostCommitConfirmationError extends Error {
	readonly taskId: string
	readonly sessionId: string
	readonly transactionId: string
	override readonly cause: unknown

	constructor({
		taskId,
		sessionId,
		transactionId,
		cause,
	}: {
		taskId: string
		sessionId: string
		transactionId: string
		cause: unknown
	}) {
		super(`Task ${taskId} was created in transaction ${transactionId}, but sync confirmation failed.`)
		this.name = 'TaskPostCommitConfirmationError'
		this.taskId = taskId
		this.sessionId = sessionId
		this.transactionId = transactionId
		this.cause = cause
	}
}

export function isTaskPersistenceTimeout(error: unknown): boolean {
	return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'TimeoutWaitingForTxIdError'
}

export function isTaskPersistenceUncertain(error: unknown): boolean {
	return error instanceof TaskPostCommitConfirmationError || isTaskPersistenceTimeout(error)
}

/** The server's message for a task name or draft already in use, or null for any other error. */
export function getTaskConflictMessage(error: unknown): string | null {
	if (!(error instanceof ORPCError) || !isDefinedError(error)) return null
	if (error.code === 'TASK_SLUG_CONFLICT') {
		return TaskSlugConflictDataSchema.safeParse(error.data).data?.message ?? null
	}
	if (error.code === 'TASK_LAUNCH_CONFLICT') {
		return TaskLaunchConflictDataSchema.safeParse(error.data).data?.message ?? null
	}
	return null
}

/** The defined recipe rejection carries the action that lets the owner launch with delivery Off. */
export function getTaskRecipeError(error: unknown): string | null {
	if (!(error instanceof ORPCError) || !isDefinedError(error) || error.code !== 'UNSUPPORTED_RECIPE') return null
	const data = error.data
	return data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
		? data.message
		: null
}

export function getTaskCreationError(error: unknown, timeoutMessage: string): TaskCreationErrorDetails {
	if (isTaskPersistenceUncertain(error)) {
		return { errorMessage: timeoutMessage }
	}
	return getRejectedTaskCreationError(error)
}

export function getRejectedTaskCreationError(error: unknown): TaskCreationErrorDetails {
	const rejectionMessage = getTaskConflictMessage(error) ?? getTaskRecipeError(error)
	if (rejectionMessage) {
		return { errorMessage: rejectionMessage }
	}

	const lookupError = getTicketLookupError(error)
	if (lookupError) {
		return {
			errorMessage: lookupError.message,
			resolutionHint: lookupError.resolutionHint,
		}
	}

	return { errorMessage: 'Task creation failed.' }
}

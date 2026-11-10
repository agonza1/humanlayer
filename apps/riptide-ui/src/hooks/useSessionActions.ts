import { useMemo, useRef, useState } from 'react'
import { uuidv7 } from 'uuidv7'

import { createSessionActions, createSessionV2Actions, type OptimisticLaunchSessionParams } from '@/actions/sessions'
import { useSync, useSyncInternal } from '@/components/providers/SyncProvider'
import { useUserInfo } from '@/hooks/useUserInfo'
import { canResumeDevelopment, developmentResumeInput } from '@/lib/review-progression'
import { useRiptideApi } from '@/orpc/client'

import { useRepositorySourceLaunchGuard } from './useRepositorySourceLaunchGuard'

export function useDevelopmentResume(
	session:
		| {
				id: string
				task_id: string | null
				archived: boolean
				status: string
				execution_phase?: string | null
				execution_phase_at?: bigint | null
		  }
		| null
		| undefined,
	canManage: boolean,
) {
	const { client } = useRiptideApi()
	const key = `${session?.id}:${session?.task_id}:${session?.execution_phase_at ?? 'legacy'}`
	const retained = useRef<{ key: string; input: ReturnType<typeof developmentResumeInput> } | null>(null)
	const running = useRef(false)
	const [state, setState] = useState<{ key: string; pending: boolean; completed: boolean; error: string | null }>({
		key,
		pending: false,
		completed: false,
		error: null,
	})
	return {
		pending: state.key === key && (state.pending || state.completed),
		error: state.key === key ? state.error : null,
		resume: async () => {
			if (
				!session ||
				!canResumeDevelopment(session, canManage) ||
				running.current ||
				(state.key === key && state.completed)
			)
				return
			if (retained.current?.key !== key)
				retained.current = {
					key,
					input: developmentResumeInput(session.id, { messageId: uuidv7(), eventId: uuidv7() }),
				}
			const request = retained.current.input
			running.current = true
			setState({ key, pending: true, completed: false, error: null })
			try {
				const result = await client.sessions.v2.continue(request, { context: { silent: true } })
				if (result.kind === 'rejected') throw new Error(result.reason)
				setState({ key, pending: false, completed: true, error: null })
			} catch {
				setState({
					key,
					pending: false,
					completed: false,
					error: 'Could not resume development. Review the task for active or queued work before retrying.',
				})
			} finally {
				running.current = false
			}
		},
	}
}

/**
 * Hook to access session mutation actions with optimistic updates.
 * Provides actions like updateSessionModel, updateSessionTitle, etc.
 */
export function useSessionActions() {
	const { sessionsCollection, eventsCollection, tasksCollection, queuedMessagesCollection } = useSync()
	const { confirmTx } = useSyncInternal()
	const { client } = useRiptideApi()
	const { dbOrganizationId, userId: dbUserId } = useUserInfo()
	const { guardProjectSessionLaunch, repositorySourceSetupDialog } = useRepositorySourceLaunchGuard()

	const actions = useMemo(
		() => ({
			...createSessionActions(
				sessionsCollection,
				{
					sessions: {
						update: (input) => client.sessions.update(input),
						continue: (input) => client.sessions.continue(input),
						interrupt: (input) => client.sessions.interrupt(input),
					},
				},
				dbUserId ?? '',
				dbOrganizationId ?? '',
				eventsCollection,
				tasksCollection,
				{
					launch: (input) => client.sessions.launch(input),
					create: (input) => client.sessions.create(input),
					fork: (input) => client.sessions.v2.fork(input),
					handoff: (input) => client.sessions.handoff(input, { context: { silent: true } }),
					createV2: (input) => client.sessions.v2.create(input),
				},
				confirmTx.sessions,
			),
			...createSessionV2Actions(
				sessionsCollection,
				eventsCollection,
				queuedMessagesCollection,
				{
					continue: (input) => client.sessions.v2.continue(input),
					updateQueuedMessage: (input) => client.sessions.queuedMessages.update(input),
					deleteQueuedMessage: (input) => client.sessions.queuedMessages.delete(input),
					requestSendQueuedMessageNow: (input) => client.sessions.queuedMessages.sendNow(input),
				},
				dbUserId ?? '',
				dbOrganizationId ?? '',
				confirmTx.sessions,
				confirmTx.queuedMessages,
			),
		}),
		[
			sessionsCollection,
			client,
			dbUserId,
			dbOrganizationId,
			eventsCollection,
			tasksCollection,
			confirmTx.sessions,
			queuedMessagesCollection,
			confirmTx.queuedMessages,
		],
	)

	return useMemo(
		() => ({
			...actions,
			/**
			 * Project-backed creation entry point. Callers must render repositorySourceSetupDialog
			 * from the same hook instance so missing source preferences can resume this exact input.
			 */
			launchProjectSession: async (
				params: OptimisticLaunchSessionParams & { taskId: string; workspaceId: string },
			) =>
				guardProjectSessionLaunch({
					taskId: params.taskId,
					hostId: params.hostId,
					launch: async () => {
						const transaction = actions.launchSession(params)
						await transaction.isPersisted.promise
					},
				}),
			repositorySourceSetupDialog,
		}),
		[actions, guardProjectSessionLaunch, repositorySourceSetupDialog],
	)
}

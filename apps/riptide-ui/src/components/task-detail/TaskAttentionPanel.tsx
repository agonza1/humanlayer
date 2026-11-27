import type { Task } from '@humanlayer/db/tables/tasks'
import { type BoardAttention, type BoardDelivery, describeAuthoredAttention } from '@humanlayer/schemas/task-board'
import {
	decodeTaskAttention,
	type TaskAttention,
	TaskAttentionInputSchema,
} from '@humanlayer/schemas/zod/task-attention'
import { Button } from '@humanlayer/ui/components/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@humanlayer/ui/components/dialog'
import { Input } from '@humanlayer/ui/components/input'
import { Textarea } from '@humanlayer/ui/components/textarea'
import {
	boardAttentionAlertLabel,
	boardAttentionFollowUpLabel,
	boardAttentionLabel,
	boardDeliveryLabel,
	formatBoardUpdateTime,
} from '@humanlayer/ui/lib/task-board'
import { ORPCError } from '@orpc/client'
import { useMutation } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { useBrowserAuth } from '@/hooks/use-browser-auth'
import { useMinuteClock } from '@/hooks/useMinuteClock'
import { useRiptideApi } from '@/orpc/client'

import { AcknowledgeDeliveryBlocker } from './AcknowledgeDeliveryBlocker'

function AttentionDetails({ item }: { item: BoardAttention }) {
	const nowMs = useMinuteClock()
	return (
		<div className="min-w-0 space-y-1 break-words">
			<strong>{boardAttentionLabel(item)}</strong>
			<p>{item.reason}</p>
			{item.nextAction && <p>Next action · {item.nextAction}</p>}
			{item.responsible && item.kind !== 'external_wait' && <p>Responsible · {item.responsible}</p>}
			{item.recoveryAttempts !== undefined && <p>Recovery attempts · {item.recoveryAttempts}</p>}
			{item.followUpAt !== undefined && item.resolvedAt === undefined && (
				<p>{boardAttentionFollowUpLabel(item, nowMs)}</p>
			)}
			{item.acknowledgedAt !== undefined && item.source === 'task' && <p>Notice acknowledged</p>}
			{item.alert && <p>{boardAttentionAlertLabel(item.alert)}</p>}
			<dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
				{(
					[
						['openedAt', 'Opened'],
						['updatedAt', 'Updated'],
						['lastCheckedAt', 'Last checked'],
						['lastNoticeAt', 'Notice attempted'],
						['resolvedAt', 'Resolved'],
					] as const
				).map(([key, label]) => {
					const value = item[key]
					if (value === undefined) return null
					const time = formatBoardUpdateTime(value, nowMs)
					return (
						<div key={key} className="flex gap-1">
							<dt>{label}</dt>
							<dd>
								<time dateTime={time.dateTime} title={time.full}>
									{time.label}
								</time>
							</dd>
						</div>
					)
				})}
			</dl>
			{item.evidence && (
				<details>
					<summary>Evidence</summary>
					<p className="whitespace-pre-wrap">{item.evidence}</p>
				</details>
			)}
		</div>
	)
}

type AttentionTask = Pick<
	Task,
	'id' | 'resource_owner_user_id' | 'archived' | 'is_draft' | 'project_id' | 'task_attention'
>

export function TaskAttentionPanel({
	task,
	attention,
	delivery,
}: {
	task: AttentionTask
	attention: BoardAttention[]
	delivery: BoardDelivery | null
}) {
	const { user } = useBrowserAuth()
	const canEdit =
		!!user?.id && user.id === task.resource_owner_user_id && !task.archived && (!task.is_draft || !!task.project_id)
	const authored = decodeTaskAttention(task.task_attention)
	const lastResolved =
		authored?.authorizedBy === task.resource_owner_user_id && authored?.resolvedAt !== undefined ? authored : null
	if (attention.length === 0 && !delivery && !canEdit && !lastResolved) return null
	const editing =
		authored?.authorizedBy === user?.id && authored?.resolvedAt === undefined ? (authored ?? null) : null
	return (
		<section className="grid gap-3 p-2 text-sm" aria-label="Task attention">
			{delivery && delivery.status !== 'blocked' && <strong>{boardDeliveryLabel(delivery)}</strong>}
			{attention.map((item) => (
				<AttentionDetails key={item.source} item={item} />
			))}
			{lastResolved && (
				<details>
					<summary>Last resolved attention</summary>
					<div className="pl-3 pt-1">
						<AttentionDetails item={describeAuthoredAttention(lastResolved)} />
					</div>
				</details>
			)}
			{delivery?.status === 'blocked' && delivery.alert?.blockerId && (
				<AcknowledgeDeliveryBlocker
					key={delivery.alert.blockerId}
					taskId={task.id}
					ownerId={task.resource_owner_user_id}
					alertId={delivery.alert.blockerId}
					acknowledgedAt={delivery.alert.acknowledgedAt}
				/>
			)}
			{canEdit && <TaskAttentionActions taskId={task.id} current={editing} />}
		</section>
	)
}

function localDateTime(timestamp: number | undefined) {
	if (timestamp === undefined) return ''
	const date = new Date(timestamp)
	return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function TaskAttentionActions({ taskId, current }: { taskId: string; current: TaskAttention | null }) {
	const { client } = useRiptideApi()
	const [draft, setDraft] = useState<{ current: TaskAttention | null; kind: TaskAttention['kind'] } | null>(null)
	const [invalid, setInvalid] = useState(false)
	const options = { context: { silent: true } }
	const set = useMutation({
		mutationFn: (input: Parameters<typeof client.tasks.attention.set>[0]) =>
			client.tasks.attention.set(input, options),
		onSuccess: () => setDraft(null),
	})
	const change = useMutation({
		mutationFn: ({ action, record }: { action: 'acknowledge' | 'clear'; record: TaskAttention }) =>
			client.tasks.attention[action]({ taskId, id: record.id, revision: record.revision }, options),
	})
	const pending = set.isPending || change.isPending
	const stale = (error: unknown) => error instanceof ORPCError && error.code === 'CONFLICT'

	function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!draft) return
		const fields = new FormData(event.currentTarget)
		const followUp = fields.get('followUp')
		const evidence = fields.get('evidence')
		const previousFollowUp = draft.current?.followUpAt
		const followUpAt =
			typeof followUp === 'string' && followUp
				? followUp === localDateTime(previousFollowUp)
					? previousFollowUp
					: new Date(followUp).getTime()
				: undefined
		const attention = TaskAttentionInputSchema.safeParse({
			kind: draft.kind,
			reason: fields.get('reason'),
			responsible: fields.get('responsible'),
			nextAction: fields.get('nextAction'),
			evidence: typeof evidence === 'string' ? evidence.trim() || undefined : undefined,
			followUpAt,
		})
		setInvalid(!attention.success)
		if (!attention.success) return
		const expected = draft.current ? { id: draft.current.id, revision: draft.current.revision } : null
		set.mutate({ taskId, expected, attention: attention.data })
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Dialog
				open={draft !== null}
				onOpenChange={(open) => {
					if (set.isPending) return
					if (open) {
						set.reset()
						change.reset()
						setInvalid(false)
						setDraft({ current, kind: current?.kind ?? 'owner_input' })
					} else setDraft(null)
				}}
			>
				<DialogTrigger asChild>
					<Button type="button" variant="outline" size="sm" disabled={pending}>
						{current ? 'Edit attention' : 'Set attention'}
					</Button>
				</DialogTrigger>
				{draft && (
					<DialogContent className="max-h-[90vh] overflow-auto">
						<DialogHeader>
							<DialogTitle>{draft.current ? 'Edit task attention' : 'Set task attention'}</DialogTitle>
							<DialogDescription>
								Record what needs to happen before this task can move forward.
							</DialogDescription>
						</DialogHeader>
						<form className="grid gap-3 text-sm" onSubmit={save}>
							<label className="grid gap-1">
								Type
								<select
									className="h-9 rounded-md border bg-background px-3"
									value={draft.kind}
									onChange={(event) => {
										const kind =
											event.target.value === 'external_wait' ? 'external_wait' : 'owner_input'
										setDraft({ ...draft, kind })
									}}
								>
									<option value="owner_input">Needs input</option>
									<option value="external_wait">Waiting externally</option>
								</select>
							</label>
							<label className="grid gap-1">
								Reason
								<Input name="reason" required maxLength={500} defaultValue={draft.current?.reason} />
							</label>
							<label className="grid gap-1">
								Responsible
								<Input
									name="responsible"
									required
									maxLength={160}
									defaultValue={draft.current?.responsible}
								/>
							</label>
							<label className="grid gap-1">
								Next action
								<Input
									name="nextAction"
									required
									maxLength={500}
									defaultValue={draft.current?.nextAction}
								/>
							</label>
							<label className="grid gap-1">
								Evidence (optional)
								<Textarea
									name="evidence"
									maxLength={2000}
									defaultValue={draft.current?.evidence}
									rows={2}
								/>
							</label>
							{draft.kind === 'external_wait' && (
								<label className="grid gap-1">
									Follow-up (optional)
									<Input
										type="datetime-local"
										name="followUp"
										defaultValue={localDateTime(draft.current?.followUpAt)}
									/>
								</label>
							)}
							{invalid && (
								<p role="alert">
									Could not save attention. Check the required fields and follow-up date.
								</p>
							)}
							{set.isError && (
								<p role="alert">
									{stale(set.error)
										? 'Attention changed. Close this form and reopen it to see the latest details.'
										: 'Could not save attention. Review the details and try again.'}
								</p>
							)}
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									disabled={pending}
									onClick={() => setDraft(null)}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={pending}>
									{set.isPending ? 'Saving…' : 'Save attention'}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				)}
			</Dialog>
			{current?.notice && current.acknowledgedAt === undefined && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending}
					onClick={() => change.mutate({ action: 'acknowledge', record: current })}
				>
					Acknowledge notice
				</Button>
			)}
			{current && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={pending}
					onClick={() => change.mutate({ action: 'clear', record: current })}
				>
					Resolve attention
				</Button>
			)}
			{change.isError && (
				<p role="alert">
					{stale(change.error)
						? 'Attention changed. Check the latest details and try again.'
						: 'Could not update attention. Try again.'}
				</p>
			)}
		</div>
	)
}

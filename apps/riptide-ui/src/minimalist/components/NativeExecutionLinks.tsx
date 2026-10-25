import { TaskDeliveryResultSchema } from '@humanlayer/db/zodschemas/task-delivery-result'
import { TaskNativeExecutionSchema } from '@humanlayer/db/zodschemas/task-native-execution'

const STAGES = { implementation: 'Implementation', in_review: 'In review', blocked: 'Blocked' } as const

/** Read-only links to the real Codex chats recorded by Main, never HumanLayer session stand-ins. */
export function NativeExecutionLinks({ value, deliveryResult }: { value: unknown; deliveryResult?: unknown }) {
	const parsed = TaskNativeExecutionSchema.safeParse(value)
	if (!parsed.success) return null
	const execution = parsed.data
	const delivered = TaskDeliveryResultSchema.safeParse(deliveryResult).success
	return (
		<div className="native-chats" role="group" aria-label="Native Codex chats">
			<div className="muted">{delivered ? 'Done' : STAGES[execution.stage]}</div>
			{[
				{ role: 'Coder', id: execution.coderThreadId },
				{ role: 'QA', id: execution.qaThreadId },
			].map(({ role, id }) =>
				id ? (
					<div key={role}>
						<a href={`codex://threads/${id}`} title={id}>
							{role} chat
						</a>
						<code className="muted"> {id}</code>
					</div>
				) : null,
			)}
			{!delivered && execution.reason ? <div>{execution.reason}</div> : null}
		</div>
	)
}

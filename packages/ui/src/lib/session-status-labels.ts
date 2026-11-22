import type { SessionStatus } from '@humanlayer/schemas/effect/session/session-status'

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
	draft: 'Draft',
	ready_for_launch: 'Queued',
	waiting_for_workspace: 'Preparing workspace',
	launching: 'Starting',
	resuming: 'Starting',
	running: 'Running',
	ready_for_input: 'Idle',
	needs_approval: 'Needs approval',
	waiting_for_usage_limit: 'Usage limit reached',
	interrupt_requested: 'Interrupting',
	interrupted: 'Interrupted',
	failed: 'Failed',
	lost: 'Stalled',
}

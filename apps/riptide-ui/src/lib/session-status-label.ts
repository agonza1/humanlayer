import type { SessionStatus } from '@humanlayer/schemas/effect/session/session-status'
import { SESSION_STATUS_LABELS } from '@humanlayer/ui/lib/session-status-labels'

import type { SessionHostState } from '@/lib/session-host-state'

export { SESSION_STATUS_LABELS } from '@humanlayer/ui/lib/session-status-labels'

export interface SessionStatusHost {
	state: SessionHostState
	hostLabel: string
	isLocal: boolean
}

const QUEUED_LABELS: Record<SessionHostState, (subject: string) => string> = {
	online: () => SESSION_STATUS_LABELS.launching,
	starting: (subject) => `Waiting for ${subject} to start`,
	updating: (subject) => `Waiting for ${subject} to update`,
	offline: (subject) => `Waiting for ${subject} to reconnect`,
}

function isSessionStatus(status: string): status is SessionStatus {
	return Object.hasOwn(SESSION_STATUS_LABELS, status)
}

export function sessionStatusLabel(status: string | null | undefined, host?: SessionStatusHost | null): string | null {
	if (!status || !isSessionStatus(status)) return null
	if (status === 'ready_for_launch' && host) {
		return QUEUED_LABELS[host.state](host.isLocal ? 'this device' : host.hostLabel)
	}
	return SESSION_STATUS_LABELS[status]
}

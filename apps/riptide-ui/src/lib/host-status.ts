import type { OnlineHost } from '@humanlayer/db/tables/online-hosts'
import { HOST_DELETE_AFTER_MS } from '@humanlayer/riptide-api-contract/api/hosts/delete'

export { getHostStatus } from '@humanlayer/schemas/zod/host/heartbeat'

export function canDeleteHost(host: Pick<OnlineHost, 'status' | 'last_seen'>, nowMs: number): boolean {
	return host.status === 'offline' && host.last_seen <= BigInt(nowMs) - BigInt(HOST_DELETE_AFTER_MS)
}

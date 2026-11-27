export type HostHeartbeat = { status: 'online' | 'offline'; last_seen: bigint | number | string }

/** Daemons beat every 15 seconds. Lagging timestamps and explicit offline registrations are distinct. */
export const HOST_STALE_AFTER_MS = 30_000
export function getHostStatus(host: HostHeartbeat, nowMs: number) {
	if (host.status === 'offline') return 'offline'
	return nowMs - Number(host.last_seen) >= HOST_STALE_AFTER_MS ? 'stale' : 'online'
}

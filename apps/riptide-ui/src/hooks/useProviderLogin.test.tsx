import { createCollection, type SyncConfig } from '@tanstack/db'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProviderLogin } from './useProviderLogin'
const { useAuth, useSync } = vi.hoisted(() => ({ useAuth: vi.fn(), useSync: vi.fn() }))
vi.mock('@workos-inc/authkit-react', () => ({ useAuth }))
vi.mock('@/components/providers/SyncProvider', () => ({ useSync, useSyncInternal: () => ({ confirmTx: {} }) }))
vi.mock('@/orpc/client', () => ({ useRiptideApi: () => ({ client: {} }) }))
function collection<T extends { id: string }>(rows: T[]) {
	const sync = vi.fn<SyncConfig<T>['sync']>(({ begin, write, commit, markReady }) => {
		begin()
		for (const value of rows) write({ type: 'insert', value })
		commit()
		markReady()
	})
	return createCollection({ getKey: (row: T) => row.id, sync: { sync } })
}
const hostId = 'same-machine'
function setHosts(ownerStatus: 'online' | 'offline', otherStatus: 'online' | 'offline') {
	useSync.mockReturnValue({
		onlineHostsCollection: collection([
			{
				id: 'other',
				host_id: hostId,
				user_id: 'other-user',
				status: otherStatus,
				capabilities: ['providerLogin'],
			},
			{
				id: 'owner',
				host_id: hostId,
				user_id: 'owner-user',
				status: ownerStatus,
				capabilities: ['providerLogin'],
			},
		]),
		providerLoginRequestsCollection: collection<{ id: string; host_id: string; user_id: string }>([]),
	})
	useAuth.mockReturnValue({ user: { id: 'owner-user' } })
}
afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})
describe('provider sign-in host ownership', () => {
	it('keeps the owner host ready when another account registered the same machine offline', async () => {
		setHosts('online', 'offline')
		const { result } = renderHook(() => useProviderLogin(hostId))
		await waitFor(() => expect(result.current.host).toEqual({ state: 'ready' }))
	})
	it('does not offer sign-in through another account online registration', async () => {
		setHosts('offline', 'online')
		const { result } = renderHook(() => useProviderLogin(hostId))
		await waitFor(() => expect(result.current.host).toEqual({ state: 'offline' }))
	})
	it('updates host readiness when the signed-in account changes', async () => {
		setHosts('online', 'offline')
		const { result, rerender } = renderHook(() => useProviderLogin(hostId))
		await waitFor(() => expect(result.current.host.state).toBe('ready'))
		useAuth.mockReturnValue({ user: { id: 'other-user' } })
		rerender()
		await waitFor(() => expect(result.current.host.state).toBe('offline'))
		useAuth.mockReturnValue({ user: null })
		rerender()
		await waitFor(() => expect(result.current.host.state).toBe('offline'))
	})
})

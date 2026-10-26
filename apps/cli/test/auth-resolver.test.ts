import { describe, expect, it } from 'vitest'

import { refreshWorkOSToken, resolveWorkOSTokenWithDeps } from '../src/auth'
import { isSessionExpired, type WorkOSSession } from '../src/auth/storage'

const envConfig = { apiOrigin: 'http://api.test', syncOrigin: 'http://sync.test', workosClientId: 'client_test' }

function session(overrides: Partial<WorkOSSession> = {}): WorkOSSession {
	return {
		access_token: 'access-old',
		refresh_token: 'refresh-old',
		expires_at: Date.now() + 60 * 60 * 1000,
		user_id: 'user-1',
		organization_id: 'org-1',
		...overrides,
	}
}

function token(payload: unknown) {
	return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('resolveWorkOSToken', () => {
	it('refreshes a JWT that expired before the saved one-hour metadata', async () => {
		const stored = session({ access_token: token({ exp: Math.floor(Date.now() / 1000) - 10 }) })
		let refreshed = false
		const resolved = await resolveWorkOSTokenWithDeps('local', envConfig, {
			load: async () => stored,
			save: async () => undefined,
			refresh: async () => {
				refreshed = true
				return { accessToken: 'renewed-access', refreshToken: 'renewed-refresh' }
			},
		})
		expect(refreshed).toBe(true)
		expect(resolved.access_token).toBe('renewed-access')
	})

	it('keeps a fresh five-minute JWT usable until its short refresh buffer', () => {
		expect(isSessionExpired(session({ access_token: token({ exp: Date.now() / 1000 + 300 }) }))).toBe(false)
		expect(isSessionExpired(session({ access_token: token({ exp: Date.now() / 1000 + 15 }) }))).toBe(true)
	})

	it('never extends the saved metadata expiry based on JWT claims', () => {
		expect(
			isSessionExpired(
				session({ access_token: token({ exp: Date.now() / 1000 + 3600 }), expires_at: Date.now() - 1000 }),
			),
		).toBe(true)
	})

	it.each(['opaque-token', 'not.a.jwt', token({}), token({ exp: '1' }), token(null), token({ exp: null })])(
		'retains metadata expiry for malformed or opaque token %s',
		(access_token) => {
			expect(isSessionExpired(session({ access_token }))).toBe(false)
			expect(isSessionExpired(session({ access_token, expires_at: Date.now() - 1000 }))).toBe(true)
		},
	)

	it('returns a non-expired stored token', async () => {
		let saved: WorkOSSession | undefined
		const stored = session()
		const resolved = await resolveWorkOSTokenWithDeps('local', envConfig, {
			load: async () => stored,
			save: async (_env, value) => {
				saved = value
			},
			refresh: refreshWorkOSToken,
		})

		expect(resolved).toEqual(stored)
		expect(saved).toBeUndefined()
	})

	it('refreshes and persists a near-expiry token without bearer auth', async () => {
		let saved: WorkOSSession | undefined
		const stored = session({ expires_at: Date.now() + 60 * 1000 })
		const resolved = await resolveWorkOSTokenWithDeps('local', envConfig, {
			load: async () => stored,
			save: async (_env, value) => {
				saved = value
			},
			refresh: async (_apiOrigin, refreshToken) => {
				expect(refreshToken).toBe('refresh-old')
				return { accessToken: 'access-new', refreshToken: 'refresh-new' }
			},
		})

		expect(resolved.access_token).toBe('access-new')
		expect(resolved.refresh_token).toBe('refresh-new')
		expect(saved?.access_token).toBe('access-new')
	})

	it('re-reads disk after a refresh race', async () => {
		const expired = session({ expires_at: Date.now() - 1000 })
		const rotated = session({ access_token: 'access-rotated', refresh_token: 'refresh-rotated' })
		let loads = 0
		const resolved = await resolveWorkOSTokenWithDeps('local', envConfig, {
			load: async () => (++loads === 1 ? expired : rotated),
			save: async () => undefined,
			refresh: async () => {
				throw new Error('already rotated')
			},
		})

		expect(resolved).toEqual(rotated)
	})

	it('throws clear login guidance for missing non-interactive creds', async () => {
		await expect(
			resolveWorkOSTokenWithDeps('local', envConfig, {
				load: async () => null,
				save: async () => undefined,
				refresh: refreshWorkOSToken,
			}),
		).rejects.toThrow('Run `humanlayer login` first')
	})
})

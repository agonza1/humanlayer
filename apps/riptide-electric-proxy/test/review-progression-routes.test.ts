import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { JWTValidator } from '../src/auth/effect/jwt-validator.service'
import { makeProxyRuntimeConfig } from '../src/lib/effect/proxy-runtime-config.service'
import { createAppRuntime, makeAppLayer } from '../src/lib/effect/runtime'
import { createApp } from '../src/server'

const { requests } = vi.hoisted(() => ({ requests: [] as URL[] }))
vi.mock('../src/lib/effect/electric-proxy.service', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/lib/effect/electric-proxy.service')>()
	const { Effect, Layer } = await import('effect')
	return {
		...actual,
		ElectricProxyLive: Layer.succeed(actual.ElectricProxy, {
			proxyShapeRequest: (url: URL) =>
				Effect.sync(() => {
					requests.push(new URL(url))
					return new Response('[]', { status: 200 })
				}),
		}),
	}
})

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(disposers.splice(0).map((dispose) => dispose()))
	requests.length = 0
})

function app(userOnly = false) {
	const electricShapeUrl = 'http://fictional.invalid/v1/shape',
		durableStreamsOrigin = 'http://fictional.invalid'
	const effectRuntime = createAppRuntime(
		makeAppLayer({
			proxyRuntimeConfig: makeProxyRuntimeConfig({ electricShapeUrl, durableStreamsOrigin }),
			authLayer: Layer.succeed(JWTValidator, { validateJWT: () => Effect.die('Unexpected user authentication') }),
		}),
	)
	disposers.push(() => effectRuntime.dispose())
	return createApp({
		electricShapeUrl,
		durableStreamsOrigin,
		effectRuntime,
		testAuthContext: userOnly ? { organizationId: 'org-1', userId: 'owner-1' } : undefined,
		validateDaemonToken: async (token) =>
			token === 'valid' ? { organizationId: 'org-1', userId: 'owner-1', hostId: 'host-1', createdAt: 1 } : null,
		get db(): never {
			throw new Error('Unexpected database access')
		},
	})
}

describe('review progression daemon-only Electric route', () => {
	test.each(['GET', 'POST'])(
		'scopes %s by authenticated organization, owner and host, ignoring query identity',
		async (method) => {
			const server = app()
			const response = await server.request(
				'/v2/daemon/review-progression?offset=-1&table=tasks&where=true&params[1]=forged&hostId=forged',
				{ method, headers: { 'x-daemon-authorization': 'valid' } },
			)
			expect(response.status).toBe(200)
			expect(requests).toHaveLength(1)
			const params = requests[0]?.searchParams
			expect(params?.getAll('table')).toEqual(['review_progression'])
			expect(params?.getAll('where')).toEqual([
				'("organization_id" = $1 and "resource_owner_user_id" = $2 and "host_id" = $3)',
			])
			expect([params?.get('params[1]'), params?.get('params[2]'), params?.get('params[3]')]).toEqual([
				'org-1',
				'owner-1',
				'host-1',
			])
		},
	)
	test('rejects unauthenticated, invalid-token and user-only callers before proxying', async () => {
		const server = app()
		expect((await server.request('/v2/daemon/review-progression')).status).toBe(401)
		expect(
			(
				await server.request('/v2/daemon/review-progression', {
					headers: { 'x-daemon-authorization': 'invalid' },
				})
			).status,
		).toBe(401)
		expect((await app(true).request('/v2/daemon/review-progression?hostId=forged')).status).toBe(400)
		expect(requests).toHaveLength(0)
	})
})

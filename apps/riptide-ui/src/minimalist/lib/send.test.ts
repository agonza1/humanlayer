import { describe, expect, it, vi } from 'vitest'

import { contextUsage, sendToSession } from '@/minimalist/lib/send'
import type { RiptideApiClient } from '@/orpc/client'

const session = (patch: Partial<Parameters<typeof contextUsage>[0]>) => ({
	provider: 'anthropic',
	model: 'sonnet',
	context_window_tokens: null,
	context_window_limit: null,
	...patch,
})

describe('phase-preserving composer', () => {
	it.each(['send', 'queue', 'interrupt_and_send'] as const)(
		'omits work-entry metadata for ordinary %s messages',
		async (intent) => {
			const request = vi.fn(async (_input: unknown) => ({ kind: 'continued' as const, transactionId: 'tx' }))
			const api = { sessions: { v2: { continue: request } } } as unknown as RiptideApiClient
			await sendToSession(api, 'existing-session', 'Continue this work', intent)
			expect(request).toHaveBeenCalledWith({
				sessionId: 'existing-session',
				text: 'Continue this work',
				intent,
				messageId: expect.any(String),
				eventId: expect.any(String),
			})
			expect(request.mock.calls[0]?.[0]).not.toHaveProperty('executionPhase')
			expect(request.mock.calls[0]?.[0]).not.toHaveProperty('planningSkill')
		},
	)
})

describe('contextUsage', () => {
	it('is null before the agent reports tokens', () => {
		expect(contextUsage(session({}))).toBeNull()
	})

	it('uses the reported limit', () => {
		expect(contextUsage(session({ context_window_tokens: 50_000, context_window_limit: 100_000 }))).toMatchObject({
			tokens: 50_000,
			limit: 100_000,
		})
	})

	it("falls back to the model's window when the session reports no limit", () => {
		const usage = contextUsage(session({ context_window_tokens: 20_000 }))
		expect(usage).not.toBeNull()
		expect(usage?.limit).toBeGreaterThan(0)
		expect(usage?.percent).toBeGreaterThan(0)
	})
})

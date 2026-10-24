import { describe, expect, it } from 'vitest'

import { reconcileUntilStopped } from '../src/local-delivery/lifecycle'

describe('local delivery shutdown', () => {
	it('drains in-flight reconciliation and never starts another tick', async () => {
		const controller = new AbortController()
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let steps = 0,
			completed = false
		const running = reconcileUntilStopped(
			async () => {
				steps++
				await gate
			},
			60000,
			controller.signal,
		).then(() => {
			completed = true
		})
		controller.abort()
		await Promise.resolve()
		expect(completed).toBe(false)
		release()
		await running
		expect(completed).toBe(true)
		expect(steps).toBe(1)
	})
	it('wakes a long idle polling wait when stopped', async () => {
		const controller = new AbortController()
		let notify: () => void = () => undefined
		const first = new Promise<void>((resolve) => {
			notify = resolve
		})
		let steps = 0
		const running = reconcileUntilStopped(
			async () => {
				steps++
				notify()
			},
			60000,
			controller.signal,
		)
		await first
		await Promise.resolve()
		controller.abort()
		await running
		expect(steps).toBe(1)
	})
	it('does no work after an already requested stop', async () => {
		const controller = new AbortController()
		controller.abort()
		let steps = 0
		await reconcileUntilStopped(
			async () => {
				steps++
			},
			1000,
			controller.signal,
		)
		expect(steps).toBe(0)
	})
})

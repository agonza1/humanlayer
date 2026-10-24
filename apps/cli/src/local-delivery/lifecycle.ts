import { setTimeout } from 'node:timers/promises'

/** Stop accepts no new work, drains the current tick, and wakes an idle poll wait. */
export async function reconcileUntilStopped(
	reconcile: () => Promise<void>,
	pollMs: number,
	signal: AbortSignal,
	once = false,
): Promise<void> {
	while (!signal.aborted) {
		await reconcile()
		if (once || signal.aborted) return
		try {
			await setTimeout(pollMs, undefined, { signal })
		} catch (error) {
			if (!signal.aborted) throw error
		}
	}
}

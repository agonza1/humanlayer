import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { coalesceSamples, processTable, type Identity } from './process-table'

export interface CommandResult {
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
	aborted: boolean
}

/** Track ancestry, not process groups: compilers can create groups of their own. */
export async function runOwnedCommand(
	command: string,
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
): Promise<CommandResult> {
	options.signal?.throwIfAborted()
	// Fail closed before launching work if ownership cannot be inspected on this host.
	await processTable()
	options.signal?.throwIfAborted()
	const child = spawn('bash', ['-c', command], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString()
	})
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString()
	})
	const exited = new Promise<number>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', (code) => resolve(code ?? -1))
	})
	void exited.catch(() => {})
	const owned = new Map<number, Identity>()
	let root: Identity | undefined
	async function discover() {
		const table = await processTable()
		if (!root) {
			root = table.find((entry) => entry.pid === child.pid)
			if (root) owned.set(root.pid, root)
		}
		let added = true
		while (added) {
			added = false
			for (const entry of table) {
				const parent = owned.get(entry.parent)
				if (
					!owned.has(entry.pid) &&
					parent &&
					table.some((p) => p.pid === parent.pid && p.started === parent.started)
				) {
					owned.set(entry.pid, entry)
					added = true
				}
			}
		}
		return table.filter((entry) => owned.get(entry.pid)?.started === entry.started)
	}
	const sample = coalesceSamples(discover)
	let timedOut = false
	let aborted = false
	let cleanup: Promise<void> | undefined
	let cleanupError: unknown
	const signalPid = (pid: number, signal: NodeJS.Signals) => {
		try {
			process.kill(pid, signal)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
		}
	}
	const terminate = (reason: 'timeout' | 'abort') => {
		if (cleanup) return
		timedOut = reason === 'timeout'
		aborted = reason === 'abort'
		clearInterval(poll)
		cleanup = (async () => {
			// Freeze every discovered owner before taking the final ancestry snapshot.
			// Keep identities after reparenting and never signal a reused PID.
			let live = await sample()
			const frozen = new Set<number>()
			const freezeDeadline = Date.now() + 2_000
			while (live.some((entry) => !frozen.has(entry.pid))) {
				for (const entry of live) {
					signalPid(entry.pid, 'SIGSTOP')
					frozen.add(entry.pid)
				}
				live = await discover()
				if (Date.now() > freezeDeadline) throw new Error('Owned process tree did not quiesce')
			}
			for (const entry of live.toReversed()) {
				signalPid(entry.pid, 'SIGTERM')
				signalPid(entry.pid, 'SIGCONT')
			}
			await delay(300)
			for (const entry of (await discover()).toReversed()) signalPid(entry.pid, 'SIGKILL')
			await exited
			const reapDeadline = Date.now() + 1_000
			while ((await discover()).some((entry) => !entry.state.startsWith('Z'))) {
				if (Date.now() > reapDeadline) throw new Error('Owned processes survived forceful cleanup')
				await delay(25)
			}
		})().catch((error) => {
			cleanupError = error
			// This handle owns the direct child even when process-table inspection fails.
			child.kill('SIGKILL')
		})
	}
	const poll = setInterval(() => {
		void sample().catch((error) => {
			cleanupError = error
			terminate('abort')
		})
	}, 50)
	const timer = setTimeout(() => terminate('timeout'), options.timeout)
	const onAbort = () => terminate('abort')
	options.signal?.addEventListener('abort', onAbort, { once: true })
	if (options.signal?.aborted) onAbort()
	try {
		await sample()
		const exitCode = await exited
		await cleanup
		if (cleanupError) throw cleanupError
		return { stdout, stderr, exitCode: timedOut || aborted ? -1 : exitCode, timedOut, aborted }
	} catch (error) {
		terminate('abort')
		await cleanup
		await exited.catch(() => {})
		throw error
	} finally {
		clearTimeout(timer)
		clearInterval(poll)
		options.signal?.removeEventListener('abort', onAbort)
		child.stdout.destroy()
		child.stderr.destroy()
	}
}

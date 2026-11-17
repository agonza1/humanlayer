import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import z from 'zod/v4'

import { runOwnedCommand } from './owned-process'

const exec = promisify(execFile)
const queues = new Map<string, Promise<void>>()

function evidenceName(task: string) {
	return `humanlayer-verification-${createHash('sha256').update(task).digest('hex').slice(0, 16)}.json`
}

/** One lane per task checkout, shared by parent and child agents; ordinary tools bypass it. */
export async function serialVerification<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve()
	let release = () => {}
	const tail = new Promise<void>((resolve) => {
		release = resolve
	})
	const queued = previous.then(() => tail)
	queues.set(key, queued)
	void queued.then(() => {
		if (queues.get(key) === queued) queues.delete(key)
	})
	try {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener('abort', onAbort)
				reject(signal.reason)
			}
			signal.addEventListener('abort', onAbort, { once: true })
			void previous.then(() => {
				signal.removeEventListener('abort', onAbort)
				resolve()
			})
			if (signal.aborted) onAbort()
		})
		signal.throwIfAborted()
		return await run()
	} finally {
		release()
	}
}

const evidenceSchema = z.object({
	command: z.string(),
	scope: z.string(),
	cwd: z.string(),
	revision: z.string(),
	finding: z.string(),
	session: z.string(),
	passed: z.boolean(),
	timedOut: z.boolean(),
	aborted: z.boolean(),
	exitCode: z.number(),
	completedAt: z.string(),
})
export type VerificationEvidence = z.infer<typeof evidenceSchema>

export function canReuseVerification(
	evidence: VerificationEvidence,
	input: { command: string; scope: string; cwd: string; revision: string; finding: string; clean: boolean },
): boolean {
	return (
		input.clean &&
		evidence.passed &&
		!evidence.timedOut &&
		!evidence.aborted &&
		evidence.exitCode === 0 &&
		evidence.command === input.command &&
		evidence.scope === input.scope &&
		evidence.cwd === input.cwd &&
		evidence.revision === input.revision &&
		evidence.finding === input.finding
	)
}

async function git(cwd: string, args: string[]) {
	return (await exec('git', args, { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}

export async function verificationHandoff(cwd: string, task: string): Promise<string> {
	try {
		const revision = await git(cwd, ['rev-parse', 'HEAD'])
		const clean = !(await git(cwd, ['status', '--porcelain', '--untracked-files=all']))
		const path = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', evidenceName(task)])
		const records = evidenceSchema.array().parse(JSON.parse(await readFile(path, 'utf8')))
		return `Implementation verification evidence (current HEAD=${revision}, clean=${clean}). These are recorded outcomes, not independent QA. Reuse only matching successful evidence after checking for new findings; use execution=verification to revalidate eligibility. Never promote failures or stale/dirty evidence to passes.\n${JSON.stringify(records)}`
	} catch {
		return 'Implementation verification evidence is unavailable. Do not infer successful checks or repeat full monorepo suites by default; report the gap and run only necessary affected checks.'
	}
}

export async function executeVerification(input: {
	command: string
	scope: string
	finding: string
	cwd: string
	timeout: number
	signal: AbortSignal
	env: NodeJS.ProcessEnv
	task: string
	session: string
	allowReuse: boolean
}): Promise<string> {
	const cwd = await realpath(input.cwd)
	const root = await git(cwd, ['rev-parse', '--show-toplevel'])
	return serialVerification(root, input.signal, async () => {
		const revision = await git(cwd, ['rev-parse', 'HEAD'])
		const clean = !(await git(cwd, ['status', '--porcelain', '--untracked-files=all']))
		const path = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', evidenceName(input.task)])
		let records: VerificationEvidence[] = []
		try {
			records = evidenceSchema.array().parse(JSON.parse(await readFile(path, 'utf8')))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		const identity = { command: input.command, scope: input.scope, cwd, revision, finding: input.finding, clean }
		const previous = records.findLast(
			(record) => record.command === input.command && record.scope === input.scope && record.cwd === cwd,
		)
		if (input.allowReuse && previous && canReuseVerification(previous, identity)) {
			return `Reused successful verification evidence: ${JSON.stringify(previous)}`
		}
		// Invalidate before execution: spawn errors and interrupted daemon runs must not
		// leave an older success available for the next PR handoff.
		records = records.filter(
			(record) => !(record.command === input.command && record.scope === input.scope && record.cwd === cwd),
		)
		const pending: VerificationEvidence = {
			command: input.command,
			scope: input.scope,
			cwd,
			revision,
			finding: input.finding,
			session: input.session,
			passed: false,
			timedOut: false,
			aborted: false,
			exitCode: -1,
			completedAt: new Date().toISOString(),
		}
		await writeFile(path, JSON.stringify([...records, pending], null, 2))
		const result = await runOwnedCommand(input.command, {
			cwd,
			env: input.env,
			timeout: input.timeout,
			signal: input.signal,
		})
		const unchanged =
			revision === (await git(cwd, ['rev-parse', 'HEAD'])) &&
			!(await git(cwd, ['status', '--porcelain', '--untracked-files=all']))
		const evidence: VerificationEvidence = {
			command: input.command,
			scope: input.scope,
			cwd,
			revision,
			finding: input.finding,
			session: input.session,
			passed: clean && unchanged && result.exitCode === 0 && !result.timedOut && !result.aborted,
			timedOut: result.timedOut,
			aborted: result.aborted,
			exitCode: result.exitCode,
			completedAt: new Date().toISOString(),
		}
		await writeFile(path, JSON.stringify([...records, evidence], null, 2))
		return `Exit code: ${result.exitCode}\n${result.stdout}\nSTDERR: ${result.stderr}\nVerification evidence: ${JSON.stringify(evidence)}`
	})
}

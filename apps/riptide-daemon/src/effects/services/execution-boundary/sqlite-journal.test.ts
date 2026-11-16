import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivationIntent, BoundaryRecord, OwnerPort, Reservation } from './contract'
import { darwinLaunchDigest, launchDarwinWorker } from './darwin-launcher'
import { ExecutionBoundaryOwner } from './owner'
import { SqliteBoundaryJournal } from './sqlite-journal'

const prepared: BoundaryRecord = {
	revision: 0,
	boundaryDigest: 'a'.repeat(64),
	controllerEpoch: 1,
	reservations: [],
	sdkUnknowns: [],
	stop: null,
	assessment: null,
}

const intent: ActivationIntent = {
	boundaryDigest: prepared.boundaryDigest,
	controllerEpoch: prepared.controllerEpoch,
	reservation: {
		id: 'child',
		capabilityId: 'compute',
		parentEffectId: null,
		operationDigest: 'b'.repeat(64),
		ownerId: 'worker',
		sequence: 1,
		phase: 'activation-requested',
	},
}

const pending: BoundaryRecord = {
	...prepared,
	revision: 1,
	reservations: [intent.reservation],
}

const sealed: BoundaryRecord = {
	...pending,
	revision: 2,
	stop: {
		id: 'stop',
		firstDeadlineAt: 1_000,
		fenceSequence: 1,
		proofRevision: 1,
		challenge: 'test-challenge',
	},
}

describe.skipIf(process.platform === 'win32')('persistent execution boundary journal', () => {
	let directory: string
	let file: string
	const journals: SqliteBoundaryJournal[] = []

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'execution-boundary-journal-'))
		file = join(directory, 'generation.sqlite')
	})

	afterEach(() => {
		for (const journal of journals.splice(0)) journal.close()
		rmSync(directory, { recursive: true, force: true })
	})

	function remember(journal: SqliteBoundaryJournal): SqliteBoundaryJournal {
		journals.push(journal)
		return journal
	}

	function createOwner(journal: SqliteBoundaryJournal, owners: readonly OwnerPort[]): ExecutionBoundaryOwner {
		return ExecutionBoundaryOwner.prepare({
			identity: {
				taskId: 'task',
				sessionId: 'session',
				rootRunId: 'run',
				generation: 'generation',
				boundaryId: 'boundary',
				incarnation: 'boot',
				policyDigest: 'a'.repeat(64),
				imageDriverDigest: 'b'.repeat(64),
			},
			controllerEpoch: 1,
			journal,
			clock: {
				now: Date.now,
				alarm: (at, fire) => {
					const timer = setTimeout(fire, Math.max(0, at - Date.now()))
					return () => clearTimeout(timer)
				},
			},
			owners,
		})
	}

	function prepareDispatch(): SqliteBoundaryJournal {
		const writer = remember(SqliteBoundaryJournal.create(file))
		expect(writer.compareAndSet(undefined, prepared)).toBe(true)
		expect(writer.compareAndSet(0, pending)).toBe(true)
		return writer
	}

	function runJournalChild(action: string, payload: BoundaryRecord | ActivationIntent) {
		return spawnSync(
			process.execPath,
			[
				'--no-env-file',
				'-e',
				`const { SqliteBoundaryJournal } = await import(process.argv[1])
				const journal = SqliteBoundaryJournal.open(process.argv[2])
				const input = JSON.parse(process.argv[3])
				${action}`,
				new URL('./sqlite-journal.ts', import.meta.url).href,
				file,
				JSON.stringify(payload),
			],
			{ encoding: 'utf8', timeout: 5_000 },
		)
	}

	it('keeps the committed seal after abrupt process exit and rejects a stale launch', () => {
		const stale = prepareDispatch()
		const child = runJournalChild(
			`if (!journal.compareAndSet(1, input)) process.exit(2)
			process.kill(process.pid, 'SIGKILL')`,
			sealed,
		)
		expect(child.error).toBeUndefined()
		expect(child.signal, child.stderr).toBe('SIGKILL')
		expect(stale.compareAndSet(1, { ...pending, revision: 2 })).toBe(false)
		const launch = vi.fn(() => 'accepted' as const)
		expect(stale.dispatch(intent, launch)).toBe('not-accepted')
		expect(launch).not.toHaveBeenCalled()

		const recovered = remember(SqliteBoundaryJournal.open(file))
		expect(recovered.read()).toEqual(sealed)
		expect(recovered.read()).not.toBe(recovered.read())
		expect(recovered.compareAndSet(2, { ...sealed, revision: 3, boundaryDigest: 'b'.repeat(64) })).toBe(false)
		expect(recovered.read()).toEqual(sealed)
	})

	it('orders an admitted launch and a competing seal from another process', () => {
		const writer = prepareDispatch()
		const result = writer.dispatch(intent, () => {
			const nested = vi.fn(() => 'accepted' as const)
			expect(() => writer.dispatch(intent, nested)).toThrow('independent commit')
			expect(nested).not.toHaveBeenCalled()
			expect(() => writer.compareAndSet(1, sealed)).toThrow('independent commit')
			expect(() => writer.close()).toThrow('independent commit')
			const contender = runJournalChild(
				`try {
					journal.compareAndSet(1, input)
					process.exit(2)
				} catch (error) {
					if (error.code !== 'SQLITE_BUSY') throw error
				}`,
				sealed,
			)
			expect(contender.error).toBeUndefined()
			expect(contender.status, contender.stderr).toBe(0)
			return 'accepted'
		})
		expect(result).toBe('accepted')
		const contender = remember(SqliteBoundaryJournal.open(file))
		expect(contender.compareAndSet(1, sealed)).toBe(true)
	})

	it('keeps an interrupted dispatch unknown and prevents replay', () => {
		prepareDispatch()
		const child = runJournalChild(
			`journal.dispatch(input, () => {
				process.kill(process.pid, 'SIGKILL')
				return 'accepted'
			})
			process.exit(2)`,
			intent,
		)
		expect(child.error).toBeUndefined()
		expect(child.signal, child.stderr).toBe('SIGKILL')

		const recovered = remember(SqliteBoundaryJournal.open(file))
		const launch = vi.fn(() => 'accepted' as const)
		expect(recovered.dispatch(intent, launch)).toBe('activation-unknown')
		expect(recovered.dispatch({ ...intent, controllerEpoch: 2 }, launch)).toBe('not-accepted')
		const changedOperation = { ...intent.reservation, operationDigest: 'c'.repeat(64) }
		expect(recovered.dispatch({ ...intent, reservation: changedOperation }, launch)).toBe('not-accepted')
		expect(launch).not.toHaveBeenCalled()
		expect(recovered.read()).toEqual(pending)
	})

	it('checks the current parent reservation before dispatching a child', () => {
		const writer = remember(SqliteBoundaryJournal.create(file))
		const parent: Reservation = { ...intent.reservation, id: 'parent', capabilityId: 'root' }
		const first: Reservation = { ...intent.reservation, parentEffectId: parent.id, sequence: 2 }
		const delayed: Reservation = { ...first, id: 'delayed', sequence: 3 }
		expect(writer.compareAndSet(undefined, prepared)).toBe(true)
		expect(writer.compareAndSet(0, { ...pending, reservations: [parent, first, delayed] })).toBe(true)
		expect(writer.dispatch({ ...intent, reservation: first }, () => 'accepted')).toBe('accepted')

		const rejected: Reservation = { ...parent, phase: 'not-accepted' }
		expect(writer.compareAndSet(1, { ...pending, revision: 2, reservations: [rejected, first, delayed] })).toBe(
			true,
		)
		const launch = vi.fn(() => 'accepted' as const)
		expect(writer.dispatch({ ...intent, reservation: delayed }, launch)).toBe('not-accepted')
		expect(launch).not.toHaveBeenCalled()
	})

	it('keeps recovery separate from creation', () => {
		expect(() => SqliteBoundaryJournal.open(file)).toThrow()
		expect(existsSync(file)).toBe(false)
		const writer = remember(SqliteBoundaryJournal.create(file))
		expect(() => SqliteBoundaryJournal.open(file)).toThrow('no prepared generation')
		expect(() => SqliteBoundaryJournal.create(file)).toThrow()
		expect(writer.compareAndSet(undefined, prepared)).toBe(true)
		expect(writer.compareAndSet(undefined, prepared)).toBe(false)
		expect(() => writer.compareAndSet(0, { ...prepared, revision: 2 })).toThrow('next revision')
	})

	it.skipIf(process.platform !== 'darwin').each(['ready', 'denied', 'wrong-account'] as const)(
		'tracks the actual Mac launch through the owner for a %s worker',
		async (mode) => {
			const writer = remember(SqliteBoundaryJournal.create(file))
			const uid = process.getuid?.() ?? 0
			const plan = {
				command: ['/bin/bash', '--noprofile', '--norc', '-c', 'printf "%s\\n" "$PWD"'] as const,
				cwd: realpathSync(directory),
				sandboxProfile:
					mode === 'denied'
						? '(version 1)(allow default)(deny process-exec)'
						: '(version 1)(allow default)(deny network*)(deny file-write*)',
				env: { PATH: '/usr/bin:/bin', LANG: 'C' },
				uid: mode === 'wrong-account' ? uid + 1 : uid,
				gid: process.getgid?.() ?? 0,
			}
			let started: ReturnType<typeof launchDarwinWorker> | undefined
			const activate = vi.fn<OwnerPort['activate']>(async (launchIntent) => {
				expect(launchDarwinWorker(writer, launchIntent, { ...plan, cwd: '/' })).toEqual({
					outcome: 'not-accepted',
				})
				started = launchDarwinWorker(writer, launchIntent, plan)
				return started.outcome
			})
			const owner = createOwner(
				writer,
				(['guest', 'device-io', 'host'] as const).map((role) => ({
					spec: {
						id: role,
						role,
						attestorId: role,
						capabilities:
							role === 'host'
								? [{ id: 'compute', parentCapabilityId: null, tracksExternalOutcome: false }]
								: [],
					},
					activate: role === 'host' ? activate : async () => 'not-accepted',
					closeAndDrain: async () => {
						throw new Error('No stop requested in the launch fixture')
					},
				})),
			)
			const ticket = owner.reserve({
				id: 'child',
				capabilityId: 'compute',
				parentEffectId: null,
				operationDigest: darwinLaunchDigest(plan),
			})
			await expect(owner.activate(ticket)).resolves.toBe(mode === 'wrong-account' ? 'not-accepted' : 'accepted')
			if (mode === 'wrong-account') {
				expect(started?.child).toBeUndefined()
				return
			}
			if (!started?.child) throw new Error('Expected a launched child')
			const [stdout, stderr, exit] = await Promise.all([
				new Response(started.child.stdout).text(),
				new Response(started.child.stderr).text(),
				started.child.exited,
			])
			if (mode === 'ready') {
				expect(exit, stderr).toBe(0)
				expect(stderr).toBe('')
				expect(stdout.trimEnd()).toBe(plan.cwd)
			} else {
				expect(exit).not.toBe(0)
				expect(stdout).toBe('')
				expect(stderr).toMatch(/not permitted|permission denied/i)
			}
			const launchIntent = activate.mock.calls[0]?.[0]
			if (!launchIntent) throw new Error('Expected a reserved launch')
			expect(launchDarwinWorker(writer, launchIntent, plan)).toMatchObject({
				outcome: 'activation-unknown',
				child: undefined,
			})
		},
	)

	it.each(['release', 'deadline'] as const)('seals a stop under real SQLite contention after %s', async (mode) => {
		const writer = remember(SqliteBoundaryJournal.create(file))
		const startedDraining = Promise.withResolvers<void>()
		const ports: OwnerPort[] = (['guest', 'device-io'] as const).map((role) => ({
			spec: { id: role, role, attestorId: role, capabilities: [] },
			activate: async () => 'not-accepted',
			closeAndDrain: vi.fn<OwnerPort['closeAndDrain']>(async (scope) => {
				startedDraining.resolve()
				return {
					challenge: scope.challenge,
					fence: 'unconfirmed',
					observation: { kind: 'unconfirmed' },
					effects: [],
					reference: 'test',
				}
			}),
		}))
		const owner = createOwner(writer, ports)
		const lock = Bun.spawn(
			[
				process.execPath,
				'--no-env-file',
				'-e',
				`
			import { Database } from 'bun:sqlite'
			const db = new Database(process.argv[1], { create: false, readwrite: true })
			db.exec('BEGIN IMMEDIATE')
			console.log('locked')
			await Bun.stdin.text()
			db.exec('ROLLBACK')
		`,
				file,
			],
			{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 5000 },
		)
		const reader = lock.stdout.getReader()
		try {
			const ready = await reader.read()
			expect(new TextDecoder().decode(ready.value)).toContain('locked')
			const deadline = Date.now() + (mode === 'release' ? 2000 : 40)
			const invalid = owner.requestStop(Number.NaN)
			const stopping = owner.requestStop(deadline)
			await expect(invalid).rejects.toMatchObject({ code: 'invalid-deadline' })
			expect(writer.read()?.stop).toBeNull()
			for (const port of ports) expect(port.closeAndDrain).not.toHaveBeenCalled()
			if (mode === 'deadline') {
				await expect(stopping).rejects.toMatchObject({ code: 'journal-busy' })
				expect(writer.read()?.stop).toBeNull()
			}
			lock.stdin.end()
			expect(await lock.exited).toBe(0)
			// The expired waiter cannot be responsible for resuming the stop.
			await startedDraining.promise
			const result = await (mode === 'release' ? stopping : owner.requestStop(Date.now() + 2000))
			expect(result).toMatchObject({
				stop: { firstDeadlineAt: deadline },
				deadlineReached: mode === 'deadline',
				ownedWritersQuiescent: false,
			})
			expect(writer.read()?.stop).toEqual(result.stop)
			for (const port of ports) expect(port.closeAndDrain).toHaveBeenCalledTimes(1)
		} finally {
			reader.releaseLock()
			lock.stdin.end()
			await lock.exited
		}
	})

	it('fails closed if the stored record no longer matches the committed payload', () => {
		const writer = remember(SqliteBoundaryJournal.create(file))
		expect(writer.compareAndSet(undefined, prepared)).toBe(true)

		const database = new Database(file, { create: false, readwrite: true })
		try {
			database.exec("UPDATE boundary_record SET payload = '{}'")
		} finally {
			database.close()
		}

		expect(() => writer.read()).toThrow('integrity check')
		expect(() => SqliteBoundaryJournal.open(file)).toThrow('integrity check')
	})
})

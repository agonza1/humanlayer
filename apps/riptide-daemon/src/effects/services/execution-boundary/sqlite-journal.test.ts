import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivationIntent, BoundaryRecord, Reservation } from './contract'
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

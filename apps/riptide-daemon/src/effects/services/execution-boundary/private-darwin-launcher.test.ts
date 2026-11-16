import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { digest, type ActivationIntent, type BoundaryRecord } from './contract'
import {
	hasNoExtendedDarwinAcl,
	inspectPrivateDarwinLaunch,
	isProtectedPrivateDriver,
	isProtectedPrivateDirectory,
	isProtectedSupervisorStorage,
	launchPrivateDarwinWorker,
	privateDarwinLaunchDigest,
	type PrivateDarwinLaunch,
	type PrivateHandoffRuntime,
} from './private-darwin-launcher'
import { SqliteBoundaryJournal } from './sqlite-journal'

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return { ...actual, lstatSync: vi.fn(actual.lstatSync), openSync: vi.fn(actual.openSync) }
})

describe('journal to private Mac handoff (injected privilege)', () => {
	let directory: string
	let path: string
	let journal: SqliteBoundaryJournal
	let plan: PrivateDarwinLaunch
	let intent: ActivationIntent
	let record: BoundaryRecord

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), 'private-handoff-')))
		path = join(directory, 'generation.sqlite')
		journal = SqliteBoundaryJournal.create(path)
		plan = {
			command: ['/bin/bash', '--noprofile', '--norc', '-c', 'exit 0'],
			workspace: { path: '/private/disposable/project', device: '1', inode: '2' },
			uid: 61840,
			gid: 61840,
			sandboxProfile: '(version 1)(allow default)(deny network*)',
			env: {
				PATH: '/usr/bin:/bin',
				HL_EFFECT_ID: 'cannot-override-binding',
				DYLD_INSERT_LIBRARIES: '/fictional',
			},
			driver: { path: '/private/supervisor/worker-launch', sha256: 'b'.repeat(64) },
		}
		intent = {
			boundaryDigest: digest(['task', 'session', 'run', 'generation', 'incarnation']),
			controllerEpoch: 3,
			reservation: {
				id: 'dispatch',
				ownerId: 'native',
				sequence: 1,
				capabilityId: 'compute',
				parentEffectId: null,
				phase: 'activation-requested',
				operationDigest: privateDarwinLaunchDigest(plan),
			},
		}
		record = {
			revision: 0,
			boundaryDigest: intent.boundaryDigest,
			controllerEpoch: 3,
			reservations: [intent.reservation],
			sdkUnknowns: [],
			stop: null,
			assessment: null,
		}
		expect(journal.compareAndSet(undefined, record)).toBe(true)
	})

	afterEach(() => {
		journal.close()
		rmSync(directory, { recursive: true, force: true })
	})

	function port() {
		return {
			validate: vi.fn<PrivateHandoffRuntime<{ pid: number }>['validate']>(
				(launch, supervisor) =>
					launch.uid === 61840 &&
					launch.gid === 61840 &&
					launch.workspace.path === '/private/disposable/project' &&
					launch.workspace.inode === '2' &&
					supervisor === directory,
			),
			start: vi.fn<PrivateHandoffRuntime<{ pid: number }>['start']>(() => ({ pid: 123 })),
		}
	}

	it('passes immutable scope, workspace/account and actual private journal to the trusted native entry', () => {
		const runtime = port()
		const result = launchPrivateDarwinWorker(journal, intent, plan, runtime)
		expect(result).toMatchObject({ outcome: 'accepted', child: { pid: 123 }, binding: intent })
		expect(result.binding).not.toBe(intent)
		const args = runtime.start.mock.calls[0]?.[0]
		expect(args?.slice(0, 9)).toEqual([
			plan.driver.path,
			'--handoff',
			'61840',
			'61840',
			'1',
			'2',
			plan.workspace.path,
			directory,
			plan.sandboxProfile,
		])
		expect(args).toContain(intent.boundaryDigest)
		expect(args).toContain(intent.reservation.operationDigest)
		expect(args).not.toContain('cannot-override-binding')
		expect(args).toContain('DYLD_INSERT_LIBRARIES')
		expect(inspectPrivateDarwinLaunch(journal, intent)).toEqual({ state: 'claimed', stop: null, revision: 0 })
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('activation-unknown')
		expect(runtime.start).toHaveBeenCalledTimes(1)
	})

	it.each(['workspace', 'uid', 'gid', 'driver'] as const)('rejects changed %s before the claim', (field) => {
		const changed = structuredClone(plan)
		const wrong = {
			workspace: { ...changed, workspace: { ...changed.workspace, inode: '99' } },
			uid: { ...changed, uid: 61841 },
			gid: { ...changed, gid: 61841 },
			driver: { ...changed, driver: { ...changed.driver, sha256: 'c'.repeat(64) } },
		}[field]
		const runtime = port()
		expect(launchPrivateDarwinWorker(journal, intent, wrong, runtime).outcome).toBe('not-accepted')
		expect(runtime.start).not.toHaveBeenCalled()
		expect(journal.inspectDispatch(intent).state).toBe('unclaimed')
	})

	it.each(['workspace', 'uid'] as const)(
		'checks current %s at the native admission point even for a reserved digest',
		(field) => {
			plan =
				field === 'workspace'
					? { ...plan, workspace: { ...plan.workspace, inode: '99' } }
					: { ...plan, uid: 61841 }
			intent = {
				...intent,
				reservation: { ...intent.reservation, operationDigest: privateDarwinLaunchDigest(plan) },
			}
			expect(journal.compareAndSet(0, { ...record, revision: 1, reservations: [intent.reservation] })).toBe(true)
			const runtime = port()
			expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('not-accepted')
			expect(runtime.validate).toHaveBeenCalledTimes(1)
			expect(runtime.start).not.toHaveBeenCalled()
		},
	)

	it('rejects an overlapping worker workspace and supervisor journal without trusting the port', () => {
		plan = { ...plan, workspace: { ...plan.workspace, path: directory } }
		intent = { ...intent, reservation: { ...intent.reservation, operationDigest: privateDarwinLaunchDigest(plan) } }
		const runtime = port()
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('not-accepted')
		expect(runtime.validate).not.toHaveBeenCalled()
	})

	it('keeps a lost native reply unknown across reopen, with the original stop and no relaunch', () => {
		const runtime = port()
		runtime.start.mockImplementation(() => {
			throw new Error('lost native reply')
		})
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('activation-unknown')
		const stop = {
			id: 'original-stop',
			firstDeadlineAt: 100,
			fenceSequence: 1,
			proofRevision: 1,
			challenge: 'challenge',
		}
		expect(journal.compareAndSet(0, { ...record, revision: 1, stop })).toBe(true)
		journal.close()
		journal = SqliteBoundaryJournal.open(path)
		expect(inspectPrivateDarwinLaunch(journal, intent)).toEqual({ state: 'claimed', stop, revision: 1 })
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('activation-unknown')
		expect(runtime.start).toHaveBeenCalledTimes(1)
	})

	it('retains a dispatch claimed before forced supervisor exit and never calls the recovered launcher', () => {
		const result = spawnSync(
			process.execPath,
			[
				'--no-env-file',
				'-e',
				`
			const { SqliteBoundaryJournal } = await import(process.argv[1])
			const { launchPrivateDarwinWorker } = await import(process.argv[2])
			const journal = SqliteBoundaryJournal.open(process.argv[3])
			launchPrivateDarwinWorker(journal, JSON.parse(process.argv[4]), JSON.parse(process.argv[5]), {
				validate: () => true, start: () => { process.kill(process.pid, 'SIGKILL') },
			})`,
				new URL('./sqlite-journal.ts', import.meta.url).href,
				new URL('./private-darwin-launcher.ts', import.meta.url).href,
				path,
				JSON.stringify(intent),
				JSON.stringify(plan),
			],
			{ encoding: 'utf8', timeout: 5000 },
		)
		expect(result.error).toBeUndefined()
		expect(result.signal, result.stderr).toBe('SIGKILL')
		const runtime = port()
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('activation-unknown')
		expect(runtime.start).not.toHaveBeenCalled()
	})

	it('rejects stopped, stale epoch and changed boundary launches before native validation', () => {
		const runtime = port()
		for (const wrong of [
			{ ...intent, controllerEpoch: 4 },
			{ ...intent, boundaryDigest: 'f'.repeat(64) },
		]) {
			expect(launchPrivateDarwinWorker(journal, wrong, plan, runtime).outcome).toBe('not-accepted')
			expect(inspectPrivateDarwinLaunch(journal, wrong).state).toBe('mismatch')
		}
		expect(
			journal.compareAndSet(0, {
				...record,
				revision: 1,
				stop: {
					id: 'stop',
					firstDeadlineAt: 100,
					fenceSequence: 1,
					proofRevision: 1,
					challenge: 'challenge',
				},
			}),
		).toBe(true)
		expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('not-accepted')
		expect(runtime.validate).not.toHaveBeenCalled()
	})

	it('orders handoff against a competing stop and retains accepted-child uncertainty', () => {
		const runtime = port()
		const contender = SqliteBoundaryJournal.open(path)
		try {
			runtime.start.mockImplementation(() => {
				expect(() => contender.compareAndSet(0, { ...record, revision: 1 })).toThrow()
				return { pid: 123 }
			})
			expect(launchPrivateDarwinWorker(journal, intent, plan, runtime)).toMatchObject({
				outcome: 'accepted',
				child: { pid: 123 },
			})
			expect(
				contender.compareAndSet(0, {
					...record,
					revision: 1,
					stop: {
						id: 'stop',
						firstDeadlineAt: 100,
						fenceSequence: 1,
						proofRevision: 1,
						challenge: 'challenge',
					},
				}),
			).toBe(true)
			expect(inspectPrivateDarwinLaunch(journal, intent).stop?.id).toBe('stop')
			expect(launchPrivateDarwinWorker(journal, intent, plan, runtime).outcome).toBe('activation-unknown')
			expect(runtime.start).toHaveBeenCalledTimes(1)
		} finally {
			contender.close()
		}
	})

	it('default runtime refuses unprivileged execution without launching a private worker', () => {
		if (process.getuid?.() === 0) return
		expect(launchPrivateDarwinWorker(journal, intent, plan).outcome).toBe('not-accepted')
	})

	it('requires a root-protected executable namespace, not only a matching driver hash', () => {
		const unsafe = join(directory, 'driver')
		writeFileSync(unsafe, 'fixture', { mode: 0o700 })
		const hash = createHash('sha256').update('fixture').digest('hex')
		expect(isProtectedPrivateDriver(unsafe, hash)).toBe(false)
		if (process.platform === 'darwin') {
			const safe = '/usr/bin/true'
			const safeHash = createHash('sha256').update(readFileSync(safe)).digest('hex')
			expect(isProtectedPrivateDriver(safe, safeHash)).toBe(true)
			expect(isProtectedPrivateDriver(safe, '0'.repeat(64))).toBe(false)
		}
	})

	it('reads the dispatch claim and stop under one snapshot and returns its revision', () => {
		const contender = SqliteBoundaryJournal.open(path)
		const read = journal.read.bind(journal)
		const next = {
			...record,
			revision: 1,
			stop: {
				id: 'snapshot-stop',
				firstDeadlineAt: 100,
				fenceSequence: 1,
				proofRevision: 1,
				challenge: 'challenge',
			},
		}
		try {
			vi.spyOn(journal, 'read').mockImplementationOnce(() => {
				const value = read()
				expect(() => contender.compareAndSet(0, next)).toThrow()
				return value
			})
			expect(inspectPrivateDarwinLaunch(journal, intent)).toEqual({ state: 'unclaimed', stop: null, revision: 0 })
			expect(contender.compareAndSet(0, next)).toBe(true)
			expect(inspectPrivateDarwinLaunch(journal, intent)).toEqual({
				state: 'unclaimed',
				stop: next.stop,
				revision: 1,
			})
		} finally {
			contender.close()
		}
	})

	it.skipIf(process.platform !== 'darwin')('rejects an extended ACL even when POSIX modes are private', () => {
		const fixture = join(directory, 'acl-driver')
		writeFileSync(fixture, 'fixture', { mode: 0o700 })
		expect(hasNoExtendedDarwinAcl(fixture)).toBe(true)
		const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow write', fixture], { encoding: 'utf8' })
		expect(grant.status, grant.stderr).toBe(0)
		expect(hasNoExtendedDarwinAcl(fixture)).toBe(false)
	})

	it('rejects a root-owned driver leaf under a real worker-writable ancestor before opening it', async () => {
		const driver = join(directory, 'driver')
		writeFileSync(driver, 'fixture', { mode: 0o500 })
		const metadata = lstatSync(driver)
		const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).lstatSync
		const stat = vi.mocked(fs.lstatSync).mockImplementation((...args: Parameters<typeof original>) => {
			if (args[0] === driver) return Object.assign(metadata, { uid: 0 })
			return original(...args)
		})
		const open = vi.mocked(fs.openSync).mockClear()
		try {
			expect(isProtectedPrivateDriver(driver, createHash('sha256').update('fixture').digest('hex'))).toBe(false)
			expect(open).not.toHaveBeenCalled()
		} finally {
			stat.mockRestore()
			open.mockRestore()
		}
	})

	it('rejects a root-owned private journal directory below a worker-replaceable ancestor', async () => {
		const privateDirectory = join(directory, 'supervisor')
		mkdirSync(privateDirectory, { mode: 0o700 })
		const metadata = lstatSync(privateDirectory)
		const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).lstatSync
		const stat = vi.mocked(fs.lstatSync).mockImplementation((...args: Parameters<typeof original>) => {
			if (args[0] === privateDirectory) return Object.assign(metadata, { uid: 0 })
			return original(...args)
		})
		try {
			expect(isProtectedPrivateDirectory(privateDirectory)).toBe(false)
			expect(isProtectedSupervisorStorage(privateDirectory, journal.supervisorStorageIdentity)).toBe(false)
		} finally {
			stat.mockRestore()
		}
	})

	it('retains the opened journal identities when its worker-writable parent replaces the path', () => {
		const pinned = journal.supervisorStorageIdentity
		expect(pinned.file.inode).toBe(lstatSync(path).ino)
		renameSync(path, join(directory, 'retained.sqlite'))
		writeFileSync(path, 'replacement', { mode: 0o600 })
		expect(journal.supervisorStorageIdentity).toEqual(pinned)
		expect(lstatSync(path).ino).not.toBe(pinned.file.inode)
		expect(isProtectedSupervisorStorage(directory, pinned)).toBe(false)
	})
})

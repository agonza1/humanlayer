import { describe, expect, it, vi } from 'vitest'

import type {
	ActivationOutcome,
	BoundaryClock,
	BoundaryIdentity,
	BoundaryJournal,
	BoundaryRecord,
	EffectRequest,
	OwnerObservation,
	OwnerPort,
	OwnerProof,
	OwnerRole,
	OwnerSpec,
	OwnerStopScope,
	StopChallenge,
} from './contract'
import { ExecutionBoundaryOwner } from './owner'

const identity: BoundaryIdentity = {
	taskId: 'task-1',
	sessionId: 'session-1',
	rootRunId: 'run-1',
	generation: 'generation-1',
	boundaryId: 'boundary-1',
	incarnation: 'incarnation-1',
	policyDigest: 'a'.repeat(64),
	imageDriverDigest: 'b'.repeat(64),
}

const specs: readonly OwnerSpec[] = [
	{
		id: 'vm',
		attestorId: 'vm-attestor',
		role: 'guest',
		capabilities: [{ id: 'compute', parentCapabilityId: null, tracksExternalOutcome: false }],
	},
	{ id: 'disk', attestorId: 'export-attestor', role: 'device-io', capabilities: [] },
	{
		id: 'host',
		attestorId: 'host-attestor',
		role: 'host',
		capabilities: [{ id: 'journal', parentCapabilityId: null, tracksExternalOutcome: false }],
	},
	{
		id: 'research',
		attestorId: 'research-attestor',
		role: 'remote',
		capabilities: [{ id: 'research-job', parentCapabilityId: 'compute', tracksExternalOutcome: true }],
	},
]

function journalFixture() {
	let record: BoundaryRecord | undefined
	let loseReply = false
	return {
		read: () => structuredClone(record),
		compareAndSet: (expected: number | undefined, next: BoundaryRecord) => {
			if (record?.revision !== expected) return false
			record = structuredClone(next)
			if (loseReply) {
				loseReply = false
				throw new Error('journal response lost')
			}
			return true
		},
		loseNextReply: () => {
			loseReply = true
		},
	} satisfies BoundaryJournal & { loseNextReply(): void }
}

function clockFixture() {
	let time = 0
	const alarms = new Map<() => void, number>()
	return {
		now: () => time,
		alarm: (at: number, wake: () => void) => {
			alarms.set(wake, at)
			return () => {
				alarms.delete(wake)
			}
		},
		advanceTo: (at: number) => {
			time = at
			for (const [wake, due] of alarms) {
				if (due > time) continue
				alarms.delete(wake)
				wake()
			}
		},
		alarmCount: () => alarms.size,
	} satisfies BoundaryClock & { advanceTo(at: number): void; alarmCount(): number }
}

function proofFor(scope: OwnerStopScope, role: OwnerRole): OwnerProof {
	const observations: Record<OwnerRole, OwnerObservation> = {
		guest: { kind: 'guest-stopped', enclosedSdkUnknownIds: scope.coverableSdkUnknownIds },
		'device-io': { kind: 'io-drained' },
		host: { kind: 'host-settled' },
		remote: { kind: 'remote-terminal' },
	}
	return {
		challenge: scope.challenge,
		fence: 'fenced',
		observation: observations[role],
		effects: scope.reservations.map((reservation) => {
			if (reservation.phase === 'reserved' || reservation.phase === 'not-accepted') {
				return { effectId: reservation.id, disposition: 'never-started', externalOutcome: 'not-accepted' }
			}
			return { effectId: reservation.id, disposition: 'terminal', externalOutcome: 'unknown' }
		}),
		reference: 'controlled-proof:' + scope.challenge.ownerId,
	}
}

type OwnerOverrides = Partial<Record<OwnerRole, Partial<Pick<OwnerPort, 'activate' | 'closeAndDrain'>>>>

function fixture(overrides: OwnerOverrides = {}) {
	const journal = journalFixture()
	const clock = clockFixture()
	const owners = specs.map((spec) => {
		const override = overrides[spec.role]
		return {
			spec,
			activate: vi.fn<OwnerPort['activate']>(override?.activate ?? (async () => 'accepted')),
			closeAndDrain: vi.fn<OwnerPort['closeAndDrain']>(
				override?.closeAndDrain ?? (async (scope) => proofFor(scope, spec.role)),
			),
		}
	})
	const options = { identity, controllerEpoch: 1, journal, clock, owners }
	const owner = ExecutionBoundaryOwner.prepare(options)
	return { owner, owners, journal, clock, options }
}

const compute = (id: string): EffectRequest => ({
	id,
	capabilityId: 'compute',
	parentEffectId: null,
	operationDigest: 'c'.repeat(64),
})

const remote: EffectRequest = {
	id: 'delegated-research',
	capabilityId: 'research-job',
	parentEffectId: 'root',
	operationDigest: 'd'.repeat(64),
}

describe('execution boundary admission', () => {
	it('persists one reservation before a start, reuses exact requests and rejects fake tickets', async () => {
		const request = compute('root')
		const f = fixture({
			guest: {
				activate: async (intent) => {
					expect(f.journal.read()?.reservations).toEqual([intent.reservation])
					expect(intent.reservation.phase).toBe('activation-requested')
					return 'accepted'
				},
			},
		})
		const ticket = f.owner.reserve(request)
		expect(f.owner.reserve(request)).toBe(ticket)
		expect(() => f.owner.reserve({ ...request, operationDigest: 'e'.repeat(64) })).toThrow('reservation-conflict')
		await expect(f.owner.activate(Symbol('execution boundary reservation'))).rejects.toMatchObject({
			code: 'invalid-ticket',
		})
		await expect(f.owner.activate(ticket)).resolves.toBe('accepted')
		await expect(f.owner.activate(ticket)).resolves.toBe('accepted')
		expect(f.owners[0]?.activate).toHaveBeenCalledTimes(1)
		expect(() => f.owner.queryEffect(request.id, 'e'.repeat(64))).toThrow('reservation-conflict')
	})

	it('rejects a delegated start if its recorded parent has since been definitively rejected', async () => {
		const reply = Promise.withResolvers<ActivationOutcome>()
		const f = fixture({ guest: { activate: () => reply.promise } })
		expect(() => f.owner.reserve(remote)).toThrow('invalid-reservation')
		const root = f.owner.reserve(compute('root'))
		expect(() => f.owner.reserve(remote)).toThrow('invalid-reservation')
		const starting = f.owner.activate(root)
		const child = f.owner.reserve(remote)
		reply.resolve('not-accepted')
		await expect(starting).resolves.toBe('not-accepted')
		await expect(f.owner.activate(child)).rejects.toMatchObject({ code: 'invalid-reservation' })
		expect(f.owners[3]?.activate).not.toHaveBeenCalled()
		const stop = await f.owner.requestStop(50)
		expect(stop.externalActionOutcomes).toEqual([{ effectId: remote.id, outcome: 'not-accepted' }])
		expect(stop.ownedWritersQuiescent).toBe(true)
	})

	it('seals the complete frontier before any teardown callback can reenter', async () => {
		const f = fixture({
			guest: {
				closeAndDrain: async (scope) => {
					expect(f.journal.read()?.stop?.id).toBe(scope.challenge.stop.id)
					expect(scope.challenge.stop.fenceSequence).toBe(1)
					expect(scope.reservations.map(({ phase }) => phase)).toEqual(['reserved'])
					expect(() => f.owner.reserve(compute('late'))).toThrow('admission-closed')
					await expect(f.owner.activate(ticket)).rejects.toMatchObject({ code: 'admission-closed' })
					return proofFor(scope, 'guest')
				},
			},
		})
		const ticket = f.owner.reserve(compute('first'))
		const stop = await f.owner.requestStop(50)
		expect(f.owners[0]?.activate).not.toHaveBeenCalled()
		expect(stop.ownedWritersQuiescent).toBe(true)
	})

	it('requires owner closure for a start whose acknowledgement arrives after the seal', async () => {
		const accepted = Promise.withResolvers<ActivationOutcome>()
		const scoped = Promise.withResolvers<OwnerStopScope>()
		const joined = Promise.withResolvers<OwnerProof>()
		const f = fixture({
			guest: {
				activate: () => accepted.promise,
				closeAndDrain: (scope) => {
					scoped.resolve(scope)
					return joined.promise
				},
			},
		})
		const request = compute('racing-start')
		const starting = f.owner.activate(f.owner.reserve(request))
		const stopping = f.owner.requestStop(50)
		const scope = await scoped.promise
		expect(scope.reservations.map(({ phase }) => phase)).toEqual(['activation-requested'])
		accepted.resolve('accepted')
		await expect(starting).resolves.toBe('activation-requested')
		expect(f.journal.read()?.assessment).toBeNull()
		joined.resolve(proofFor(scope, 'guest'))
		await expect(stopping).resolves.toMatchObject({ ownedWritersQuiescent: true })
		expect(f.owner.queryEffect(request.id, request.operationDigest)?.phase).toBe('activation-requested')
	})

	it('retains an ambiguous owner acknowledgement and never dispatches it a second time', async () => {
		const f = fixture({
			guest: {
				activate: async () => {
					throw new Error('owner acknowledgement lost')
				},
			},
		})
		const request = compute('accepted-but-reply-lost')
		const ticket = f.owner.reserve(request)
		await expect(f.owner.activate(ticket)).resolves.toBe('activation-unknown')
		await expect(f.owner.activate(ticket)).resolves.toBe('activation-unknown')
		expect(f.owner.queryEffect(request.id, request.operationDigest)?.phase).toBe('activation-unknown')
		expect(f.owners[0]?.activate).toHaveBeenCalledTimes(1)
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({ ownedWritersQuiescent: true })
	})

	it('does not dispatch a start when the durable claim reply was lost', async () => {
		const f = fixture({
			guest: {
				closeAndDrain: async (scope) => ({
					...proofFor(scope, 'guest'),
					effects: [
						{ effectId: 'ambiguous-claim', disposition: 'never-started', externalOutcome: 'not-accepted' },
					],
				}),
			},
		})
		const request = compute('ambiguous-claim')
		const ticket = f.owner.reserve(request)
		f.journal.loseNextReply()
		await expect(f.owner.activate(ticket)).rejects.toThrow('journal response lost')
		expect(f.owner.queryEffect(request.id, request.operationDigest)?.phase).toBe('activation-requested')
		await expect(f.owner.activate(ticket)).resolves.toBe('activation-requested')
		expect(f.owners[0]?.activate).not.toHaveBeenCalled()
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({ ownedWritersQuiescent: true })
	})
})

describe('execution boundary stop and recovery', () => {
	it('reuses the sealed stop and first deadline after losing the close write response', async () => {
		const f = fixture()
		f.journal.loseNextReply()
		await expect(f.owner.requestStop(25)).rejects.toThrow('journal response lost')
		const retained = f.journal.read()?.stop
		expect(retained).toMatchObject({ firstDeadlineAt: 25, fenceSequence: 0 })
		for (const port of f.owners) expect(port.closeAndDrain).not.toHaveBeenCalled()
		await expect(f.owner.requestStop(200)).resolves.toMatchObject({ stop: retained, ownedWritersQuiescent: true })
		for (const port of f.owners) expect(port.closeAndDrain).toHaveBeenCalledTimes(1)
	})

	it('shares the first deadline, cancels only a caller wait, and cannot upgrade a timed-out result', async () => {
		const entered = Promise.withResolvers<OwnerStopScope>()
		const joined = Promise.withResolvers<OwnerProof>()
		const f = fixture({
			guest: {
				closeAndDrain: (scope) => {
					entered.resolve(scope)
					return joined.promise
				},
			},
		})
		const caller = new AbortController()
		const cancelled = f.owner.requestStop(10, caller.signal)
		const cancelCheck = expect(cancelled).rejects.toMatchObject({ code: 'wait-cancelled' })
		const shorter = f.owner.requestStop(2)
		const longer = f.owner.requestStop(1000)
		const scope = await entered.promise
		caller.abort()
		await cancelCheck
		f.clock.advanceTo(9)
		expect(f.journal.read()?.assessment).toBeNull()
		f.clock.advanceTo(10)
		const assessment = await longer
		expect(assessment).toMatchObject({
			deadlineReached: true,
			ownedWritersQuiescent: false,
			stop: { firstDeadlineAt: 10 },
		})
		await expect(shorter).resolves.toEqual(assessment)
		expect(f.owners[0]?.closeAndDrain).toHaveBeenCalledTimes(1)
		expect(f.clock.alarmCount()).toBe(0)
		joined.resolve(proofFor(scope, 'guest'))
		await joined.promise
		await expect(f.owner.requestStop(1000)).resolves.toEqual(assessment)
	})

	it('still starts all teardown for an elapsed deadline and returns uncertainty', async () => {
		const f = fixture()
		f.clock.advanceTo(20)
		const assessment = await f.owner.requestStop(10)
		for (const port of f.owners) expect(port.closeAndDrain).toHaveBeenCalledTimes(1)
		expect(assessment).toMatchObject({ deadlineReached: true, ownedWritersQuiescent: false })
	})

	it('drains independent owners even when a remote owner rejects the stop query', async () => {
		const f = fixture({
			remote: {
				closeAndDrain: async () => {
					throw new Error('owner unreachable')
				},
			},
		})
		const assessment = await f.owner.requestStop(50)
		for (const port of f.owners) expect(port.closeAndDrain).toHaveBeenCalledTimes(1)
		expect(assessment).toMatchObject({
			ownedWritersQuiescent: false,
			deadlineReached: false,
			unresolvedOwners: ['research'],
		})
		expect(f.clock.alarmCount()).toBe(0)
	})

	it('reconciles the same operation under a new epoch and bars the stale controller from publishing', async () => {
		const entered = Promise.withResolvers<OwnerStopScope>()
		const oldJoin = Promise.withResolvers<OwnerProof>()
		const f = fixture({
			guest: {
				closeAndDrain: (scope) => {
					if (scope.challenge.controllerEpoch !== 1) return Promise.resolve(proofFor(scope, 'guest'))
					entered.resolve(scope)
					return oldJoin.promise
				},
			},
		})
		const oldTicket = f.owner.reserve(compute('old-ticket'))
		const oldWait = f.owner.requestStop(40)
		const oldScope = await entered.promise
		const stale = expect(oldWait).rejects.toMatchObject({ code: 'stale-owner' })
		const recovered = ExecutionBoundaryOwner.recoverStop({ ...f.options, controllerEpoch: 2 })
		await expect(recovered.activate(oldTicket)).rejects.toMatchObject({ code: 'invalid-ticket' })
		expect(() => recovered.reserve(compute('late'))).toThrow('admission-closed')
		const result = await recovered.requestStop(400)
		expect(result).toMatchObject({
			controllerEpoch: 2,
			stop: { id: oldScope.challenge.stop.id, firstDeadlineAt: 40, proofRevision: 2, fenceSequence: 1 },
			ownedWritersQuiescent: true,
		})
		expect(result.stop.challenge).not.toBe(oldScope.challenge.stop.challenge)
		oldJoin.resolve(proofFor(oldScope, 'guest'))
		await stale
		expect(f.journal.read()?.assessment).toEqual(result)
	})

	it('refuses recovery for a different incarnation or a changed capability manifest', async () => {
		const f = fixture()
		const stopping = f.owner.requestStop(50)
		expect(() =>
			ExecutionBoundaryOwner.recoverStop({
				...f.options,
				controllerEpoch: 2,
				identity: { ...identity, incarnation: 'other-boot' },
			}),
		).toThrow('stale-owner')
		expect(() =>
			ExecutionBoundaryOwner.recoverStop({ ...f.options, controllerEpoch: 2, owners: f.owners.slice(0, 3) }),
		).toThrow('stale-owner')
		await expect(stopping).resolves.toMatchObject({ controllerEpoch: 1, ownedWritersQuiescent: true })
	})
})

describe('execution boundary proof composition', () => {
	const staleFields: readonly [string, (challenge: StopChallenge) => StopChallenge][] = [
		['boundary digest', (context) => ({ ...context, boundaryDigest: 'f'.repeat(64) })],
		['epoch', (context) => ({ ...context, controllerEpoch: 0 })],
		['owner', (context) => ({ ...context, ownerId: 'another-owner' })],
		['attestor', (context) => ({ ...context, attestorId: 'different-attestor' })],
		['reservation digest', (context) => ({ ...context, ownerScopeDigest: 'f'.repeat(64) })],
		['stop identity', (context) => ({ ...context, stop: { ...context.stop, id: 'different-stop' } })],
		['frontier', (context) => ({ ...context, stop: { ...context.stop, fenceSequence: 44 } })],
		['proof revision', (context) => ({ ...context, stop: { ...context.stop, proofRevision: 0 } })],
		['challenge', (context) => ({ ...context, stop: { ...context.stop, challenge: 'other-challenge' } })],
		['deadline', (context) => ({ ...context, stop: { ...context.stop, firstDeadlineAt: 400 } })],
	]

	it.each(staleFields)('rejects a terminal observation with a mismatched %s', async (_label, mutate) => {
		const f = fixture({
			guest: {
				closeAndDrain: async (scope) => ({ ...proofFor(scope, 'guest'), challenge: mutate(scope.challenge) }),
			},
		})
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({
			ownedWritersQuiescent: false,
			authorityFenced: false,
			unresolvedOwners: ['vm'],
		})
	})

	it('never turns a fence and a stopped guest into proof that device I/O drained', async () => {
		const f = fixture({
			'device-io': {
				closeAndDrain: async (scope) => ({
					...proofFor(scope, 'device-io'),
					observation: { kind: 'unconfirmed' },
				}),
			},
		})
		f.owner.retainSdkUnknown({
			original: { id: 'guest-child', label: 'untracked child' },
			placement: { kind: 'guest-only', ownerId: 'vm' },
		})
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({
			authorityFenced: true,
			ownedWritersQuiescent: false,
			unresolvedOwners: ['disk'],
			uncoveredSdkUnknownIds: ['guest-child'],
		})
	})

	it('requires exact closure of every admitted effect, including ambiguous starts', async () => {
		const f = fixture({
			guest: { closeAndDrain: async (scope) => ({ ...proofFor(scope, 'guest'), effects: [] }) },
		})
		f.owner.reserve(compute('not-accounted-for'))
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({
			authorityFenced: true,
			ownedWritersQuiescent: false,
			unresolvedOwners: ['vm'],
		})
	})

	it('does not accept a never-started proof for an acknowledged activation', async () => {
		const f = fixture({
			guest: {
				closeAndDrain: async (scope) => ({
					...proofFor(scope, 'guest'),
					effects: [{ effectId: 'active', disposition: 'never-started', externalOutcome: 'not-accepted' }],
				}),
			},
		})
		await f.owner.activate(f.owner.reserve(compute('active')))
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({
			ownedWritersQuiescent: false,
			unresolvedOwners: ['vm'],
		})
	})

	it('retains original SDK unknowns and composes only the expressly enclosed portion', async () => {
		const f = fixture()
		const original = { id: 'enclosed-child', label: 'tool:uninstrumented' }
		const mixed = { id: 'mixed-remote-edge', label: 'tool:uninstrumented' }
		f.owner.retainSdkUnknown({ original, placement: { kind: 'guest-only', ownerId: 'vm' } })
		f.owner.retainSdkUnknown({ original: mixed, placement: { kind: 'unresolved' } })
		original.label = 'caller mutated its own input'
		const result = await f.owner.requestStop(50)
		expect(result).toMatchObject({
			originalSdkUnknowns: [{ id: 'enclosed-child', label: 'tool:uninstrumented' }, mixed],
			unknownCoverage: [
				{ id: 'enclosed-child', ownerIds: ['vm', 'disk'] },
				{ id: 'mixed-remote-edge', ownerIds: [] },
			],
			uncoveredSdkUnknownIds: ['mixed-remote-edge'],
			ownedWritersQuiescent: false,
		})
	})

	it('blocks completion for an unknown first reported while teardown is in flight', async () => {
		const entered = Promise.withResolvers<OwnerStopScope>()
		const joined = Promise.withResolvers<OwnerProof>()
		const f = fixture({
			guest: {
				closeAndDrain: (scope) => {
					entered.resolve(scope)
					return joined.promise
				},
			},
		})
		const stopping = f.owner.requestStop(50)
		const scope = await entered.promise
		f.owner.retainSdkUnknown({ original: { id: 'late', label: 'unresolved' }, placement: { kind: 'unresolved' } })
		joined.resolve(proofFor(scope, 'guest'))
		await expect(stopping).resolves.toMatchObject({
			ownedWritersQuiescent: false,
			uncoveredSdkUnknownIds: ['late'],
		})
	})

	it('keeps external action outcome uncertainty distinct from positive writer closure', async () => {
		const f = fixture()
		await f.owner.activate(f.owner.reserve(compute('root')))
		await f.owner.activate(f.owner.reserve(remote))
		await expect(f.owner.requestStop(50)).resolves.toMatchObject({
			ownedWritersQuiescent: true,
			externalActionOutcomesKnown: false,
			externalActionOutcomes: [{ effectId: remote.id, outcome: 'unknown' }],
		})
	})
})

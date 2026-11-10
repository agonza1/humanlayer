import { randomUUID } from 'node:crypto'

import {
	boundaryDigest,
	describeStopScope,
	isDigest,
	isOpaqueId,
	type ActivationOutcome,
	type BoundaryClock,
	type BoundaryIdentity,
	type BoundaryJournal,
	type BoundaryRecord,
	type Capability,
	type EffectRequest,
	type OwnerPort,
	type OwnerProof,
	type OwnerRole,
	type Reservation,
	type RetainedUnknown,
	type StopAssessment,
	type StopIntent,
} from './contract'
import { assessStop } from './verifier'

type BoundaryErrorCode =
	| 'invalid-boundary'
	| 'stale-owner'
	| 'journal-conflict'
	| 'journal-busy'
	| 'admission-closed'
	| 'invalid-reservation'
	| 'reservation-conflict'
	| 'invalid-ticket'
	| 'unknown-conflict'
	| 'invalid-deadline'
	| 'wait-cancelled'

export class BoundaryError extends Error {
	constructor(readonly code: BoundaryErrorCode) {
		super(code)
		this.name = 'BoundaryError'
	}
}

export interface BoundaryOwnerOptions {
	readonly identity: BoundaryIdentity
	readonly controllerEpoch: number
	readonly journal: BoundaryJournal
	readonly clock: BoundaryClock
	readonly owners: readonly OwnerPort[]
}

interface Change<A> {
	readonly next: BoundaryRecord
	readonly value: A
}

function unchanged<A>(next: BoundaryRecord, value: A): Change<A> {
	return { next, value }
}

const ownerRoles = new Set<OwnerRole>(['guest', 'device-io', 'host', 'remote'])

function validateManifest(identity: BoundaryIdentity, epoch: number, owners: readonly OwnerPort[]): void {
	const ids = [
		identity.taskId,
		identity.sessionId,
		identity.rootRunId,
		identity.generation,
		identity.boundaryId,
		identity.incarnation,
	]
	if (
		!ids.every(isOpaqueId) ||
		!isDigest(identity.policyDigest) ||
		!isDigest(identity.imageDriverDigest) ||
		!Number.isSafeInteger(epoch) ||
		epoch < 1 ||
		!owners.some(({ spec }) => spec.role === 'guest') ||
		!owners.some(({ spec }) => spec.role === 'device-io')
	) {
		throw new BoundaryError('invalid-boundary')
	}
	const ownerIds = new Set<string>()
	const capabilities = new Map<string, Capability>()
	for (const { spec } of owners) {
		if (
			!isOpaqueId(spec.id) ||
			!isOpaqueId(spec.attestorId) ||
			!ownerRoles.has(spec.role) ||
			ownerIds.has(spec.id)
		) {
			throw new BoundaryError('invalid-boundary')
		}
		ownerIds.add(spec.id)
		for (const capability of spec.capabilities) {
			if (
				!isOpaqueId(capability.id) ||
				typeof capability.tracksExternalOutcome !== 'boolean' ||
				capabilities.has(capability.id)
			) {
				throw new BoundaryError('invalid-boundary')
			}
			capabilities.set(capability.id, capability)
		}
	}
	for (const capability of capabilities.values()) {
		const seen = new Set([capability.id])
		for (let parentId = capability.parentCapabilityId; parentId !== null; ) {
			const parent = capabilities.get(parentId)
			if (!parent || seen.has(parentId)) throw new BoundaryError('invalid-boundary')
			seen.add(parentId)
			parentId = parent.parentCapabilityId
		}
	}
}

function sameRequest(previous: Reservation, request: EffectRequest): boolean {
	return (
		previous.capabilityId === request.capabilityId &&
		previous.parentEffectId === request.parentEffectId &&
		previous.operationDigest === request.operationDigest
	)
}

function waitForStop(work: Promise<StopAssessment>, signal?: AbortSignal): Promise<StopAssessment> {
	if (!signal) return work.then((assessment) => structuredClone(assessment))
	return new Promise((resolve, reject) => {
		const remove = () => signal.removeEventListener('abort', onAbort)
		const onAbort = () => {
			remove()
			reject(new BoundaryError('wait-cancelled'))
		}
		// Always observe the shared work, even if this caller cancels before it finishes.
		void work.then(
			(assessment) => {
				remove()
				resolve(structuredClone(assessment))
			},
			(error: unknown) => {
				remove()
				reject(error)
			},
		)
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
	})
}

// The trusted caller must already own the task/generation slot.
export class ExecutionBoundaryOwner {
	private readonly digest: string
	private readonly epoch: number
	private readonly journal: BoundaryJournal
	private readonly clock: BoundaryClock
	private readonly ports: readonly OwnerPort[]
	private readonly capabilityOwners = new Map<string, { readonly capability: Capability; readonly port: OwnerPort }>()
	private readonly ticketIds = new Map<symbol, string>()
	private readonly tickets = new Map<string, symbol>()
	private pendingStop: Promise<StopAssessment> | undefined
	private requestedStopDeadline: number | undefined
	private waitingForSeal: PromiseWithResolvers<StopAssessment> | undefined

	private constructor(options: BoundaryOwnerOptions) {
		validateManifest(options.identity, options.controllerEpoch, options.owners)
		this.ports = options.owners.map((port) => ({
			spec: structuredClone(port.spec),
			activate: port.activate.bind(port),
			closeAndDrain: port.closeAndDrain.bind(port),
		}))
		this.digest = boundaryDigest(
			options.identity,
			this.ports.map(({ spec }) => spec),
		)
		this.epoch = options.controllerEpoch
		this.journal = options.journal
		this.clock = options.clock
		for (const port of this.ports) {
			for (const capability of port.spec.capabilities)
				this.capabilityOwners.set(capability.id, { capability, port })
		}
	}

	static prepare(options: BoundaryOwnerOptions): ExecutionBoundaryOwner {
		const owner = new ExecutionBoundaryOwner(options)
		if (
			!owner.journal.compareAndSet(undefined, {
				revision: 0,
				boundaryDigest: owner.digest,
				controllerEpoch: owner.epoch,
				reservations: [],
				sdkUnknowns: [],
				stop: null,
				assessment: null,
			})
		) {
			throw new BoundaryError('journal-conflict')
		}
		return owner
	}

	// Recover only an already sealed stop, under the next controller epoch. This cannot
	// reopen a generation, extend the original deadline, or re-admit old tickets.
	static recoverStop(options: BoundaryOwnerOptions): ExecutionBoundaryOwner {
		const owner = new ExecutionBoundaryOwner(options)
		const previous = owner.journal.read()
		if (
			!previous?.stop ||
			previous.assessment ||
			previous.boundaryDigest !== owner.digest ||
			previous.controllerEpoch + 1 !== owner.epoch
		) {
			throw new BoundaryError('stale-owner')
		}
		const next: BoundaryRecord = {
			...previous,
			revision: previous.revision + 1,
			controllerEpoch: owner.epoch,
			stop: {
				...previous.stop,
				proofRevision: previous.stop.proofRevision + 1,
				challenge: randomUUID(),
			},
		}
		if (!owner.journal.compareAndSet(previous.revision, next)) throw new BoundaryError('journal-conflict')
		owner.requestedStopDeadline = previous.stop.firstDeadlineAt
		return owner
	}

	private current(): BoundaryRecord {
		const record = this.journal.read()
		if (!record || record.boundaryDigest !== this.digest || record.controllerEpoch !== this.epoch) {
			throw new BoundaryError('stale-owner')
		}
		return record
	}

	private update<A>(transition: (record: BoundaryRecord) => Change<A>): A {
		for (let retry = 0; retry < 8; retry++) {
			const current = this.current()
			const { next, value } = transition(current)
			if (next === current) return value
			if (this.journal.compareAndSet(current.revision, { ...next, revision: current.revision + 1 })) return value
		}
		throw new BoundaryError('journal-conflict')
	}

	reserve(request: EffectRequest): symbol {
		if (this.requestedStopDeadline !== undefined) throw new BoundaryError('admission-closed')
		const entry = this.capabilityOwners.get(request.capabilityId)
		if (!entry || !isOpaqueId(request.id) || !isDigest(request.operationDigest)) {
			throw new BoundaryError('invalid-reservation')
		}
		this.update((record) => {
			if (record.stop) throw new BoundaryError('admission-closed')
			const previous = record.reservations.find((reservation) => reservation.id === request.id)
			if (previous) {
				if (!sameRequest(previous, request)) throw new BoundaryError('reservation-conflict')
				return unchanged(record, undefined)
			}
			const parent = record.reservations.find((reservation) => reservation.id === request.parentEffectId)
			if (entry.capability.parentCapabilityId === null) {
				if (request.parentEffectId !== null) throw new BoundaryError('invalid-reservation')
			} else if (
				!parent ||
				parent.capabilityId !== entry.capability.parentCapabilityId ||
				parent.phase === 'reserved' ||
				parent.phase === 'not-accepted'
			) {
				throw new BoundaryError('invalid-reservation')
			}
			const reservation: Reservation = {
				id: request.id,
				capabilityId: request.capabilityId,
				parentEffectId: request.parentEffectId,
				operationDigest: request.operationDigest,
				ownerId: entry.port.spec.id,
				sequence: record.reservations.length + 1,
				phase: 'reserved',
			}
			return { next: { ...record, reservations: [...record.reservations, reservation] }, value: undefined }
		})
		const previousTicket = this.tickets.get(request.id)
		if (previousTicket) return previousTicket
		const ticket = Symbol('execution boundary reservation')
		this.tickets.set(request.id, ticket)
		this.ticketIds.set(ticket, request.id)
		return ticket
	}

	async activate(ticket: symbol): Promise<Reservation['phase']> {
		const id = this.ticketIds.get(ticket)
		if (!id) throw new BoundaryError('invalid-ticket')
		if (this.requestedStopDeadline !== undefined) throw new BoundaryError('admission-closed')
		const { reservation, dispatch } = this.update((record) => {
			if (record.stop) throw new BoundaryError('admission-closed')
			const original = record.reservations.find((effect) => effect.id === id)
			if (!original) throw new BoundaryError('invalid-ticket')
			if (original.phase !== 'reserved') return unchanged(record, { reservation: original, dispatch: false })
			if (original.parentEffectId !== null) {
				const parent = record.reservations.find((effect) => effect.id === original.parentEffectId)
				if (!parent || parent.phase === 'reserved' || parent.phase === 'not-accepted') {
					throw new BoundaryError('invalid-reservation')
				}
			}
			const claimed: Reservation = { ...original, phase: 'activation-requested' }
			const reservations = record.reservations.map((effect) => (effect.id === id ? claimed : effect))
			return { next: { ...record, reservations }, value: { reservation: claimed, dispatch: true } }
		})
		if (!dispatch) return reservation.phase
		const entry = this.capabilityOwners.get(reservation.capabilityId)
		if (!entry) throw new BoundaryError('invalid-reservation')
		let outcome: ActivationOutcome = 'activation-unknown'
		try {
			const observed = await entry.port.activate({
				boundaryDigest: this.digest,
				controllerEpoch: this.epoch,
				reservation: structuredClone(reservation),
			})
			if (observed === 'accepted' || observed === 'not-accepted') outcome = observed
		} catch {
			// The owner may have accepted work before the acknowledgement failed.
		}
		return this.update((record) => {
			const original = record.reservations.find((effect) => effect.id === id)
			if (!original) throw new BoundaryError('invalid-ticket')
			// Freeze the entire reservation frontier at seal, including unresolved starts.
			// An acknowledgement arriving after that point is not a terminal proof.
			if (record.stop) return unchanged(record, original.phase)
			const reservations = record.reservations.map((effect) =>
				effect.id === id ? { ...effect, phase: outcome } : effect,
			)
			return { next: { ...record, reservations }, value: outcome }
		})
	}

	queryEffect(id: string, operationDigest: string): Reservation | undefined {
		const match = this.current().reservations.find((effect) => effect.id === id)
		if (match && match.operationDigest !== operationDigest) throw new BoundaryError('reservation-conflict')
		return structuredClone(match)
	}

	retainSdkUnknown(input: RetainedUnknown): void {
		if (!isOpaqueId(input.original.id)) throw new BoundaryError('unknown-conflict')
		if (input.placement.kind === 'guest-only') {
			const ownerId = input.placement.ownerId
			if (!this.ports.some(({ spec }) => spec.id === ownerId && spec.role === 'guest')) {
				throw new BoundaryError('unknown-conflict')
			}
		}
		const unknown = structuredClone(input)
		this.update((record) => {
			const prior = record.sdkUnknowns.find((item) => item.original.id === unknown.original.id)
			if (prior) {
				const samePlacement =
					prior.placement.kind === 'unresolved'
						? unknown.placement.kind === 'unresolved'
						: unknown.placement.kind === 'guest-only' &&
							prior.placement.ownerId === unknown.placement.ownerId
				if (prior.original.label !== unknown.original.label || !samePlacement)
					throw new BoundaryError('unknown-conflict')
				return unchanged(record, undefined)
			}
			if (record.assessment) throw new BoundaryError('admission-closed')
			return { next: { ...record, sdkUnknowns: [...record.sdkUnknowns, unknown] }, value: undefined }
		})
	}

	async requestStop(firstDeadlineAt: number, signal?: AbortSignal): Promise<StopAssessment> {
		if (!this.pendingStop) {
			if (
				this.requestedStopDeadline === undefined &&
				(!Number.isSafeInteger(firstDeadlineAt) || firstDeadlineAt < 0)
			)
				throw new BoundaryError('invalid-deadline')
			this.requestedStopDeadline ??= firstDeadlineAt
			const work = this.sealAndDrain(this.requestedStopDeadline)
			this.pendingStop = work
			void work.catch(() => {
				if (this.pendingStop !== work) return
				this.pendingStop = undefined
				this.waitingForSeal = undefined
			})
		}
		const work = this.waitingForSeal
			? Promise.race([this.pendingStop, this.waitingForSeal.promise])
			: this.pendingStop
		return waitForStop(work, signal)
	}

	private async sealAndDrain(firstDeadlineAt: number): Promise<StopAssessment> {
		for (;;) {
			let sealed: Pick<BoundaryRecord, 'stop' | 'assessment'>
			try {
				sealed = this.update<Pick<BoundaryRecord, 'stop' | 'assessment'>>((record) => {
					if (record.stop) return unchanged(record, record)
					const stop: StopIntent = {
						id: randomUUID(),
						firstDeadlineAt,
						fenceSequence: record.reservations.length,
						proofRevision: 1,
						challenge: randomUUID(),
					}
					const next = { ...record, stop }
					return { next, value: next }
				})
			} catch (error) {
				if (!this.journal.isContention?.(error)) throw error
				const now = this.clock.now()
				this.waitingForSeal ??= Promise.withResolvers<StopAssessment>()
				const expired = now >= firstDeadlineAt
				if (expired) this.waitingForSeal.reject(new BoundaryError('journal-busy'))
				// Report the uncommitted seal at the deadline. The owner still
				// reconciles it once the competing launch releases the lock.
				await new Promise<void>((resolve) => {
					this.clock.alarm(expired ? now + 250 : Math.min(now + 10, firstDeadlineAt), resolve)
				})
				continue
			}
			const { stop, assessment } = sealed
			if (!stop) throw new BoundaryError('journal-conflict')
			this.waitingForSeal = undefined
			this.requestedStopDeadline = stop.firstDeadlineAt
			return assessment ?? Promise.resolve().then(() => this.drain(stop))
		}
	}

	private async drain(stop: StopIntent): Promise<StopAssessment> {
		const sealed = this.current()
		const observations = new Map<string, OwnerProof>()
		const drains = this.ports.map(async (port) => {
			try {
				const scope = describeStopScope(sealed, stop, port.spec)
				const proof = await port.closeAndDrain(structuredClone(scope))
				observations.set(port.spec.id, structuredClone(proof))
			} catch {
				// Missing evidence leaves this owner unresolved; other owners still drain.
			}
		})
		let cancelAlarm = () => {}
		const deadline = new Promise<boolean>((resolve) => {
			if (this.clock.now() >= stop.firstDeadlineAt) resolve(true)
			else cancelAlarm = this.clock.alarm(stop.firstDeadlineAt, () => resolve(true))
		})
		let timedOut: boolean
		try {
			timedOut = await Promise.race([deadline, Promise.all(drains).then(() => false)])
		} finally {
			cancelAlarm()
		}
		const specs = this.ports.map(({ spec }) => spec)
		return this.update((record) => {
			if (record.assessment) return unchanged(record, record.assessment)
			const deadlineReached = timedOut || this.clock.now() >= stop.firstDeadlineAt
			const assessment = assessStop(record, stop, specs, observations, deadlineReached)
			return { next: { ...record, assessment }, value: assessment }
		})
	}
}

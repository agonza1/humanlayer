import { createHash } from 'node:crypto'

export interface BoundaryIdentity {
	readonly taskId: string
	readonly sessionId: string
	readonly rootRunId: string
	readonly generation: string
	readonly boundaryId: string
	readonly incarnation: string
	readonly policyDigest: string
	readonly imageDriverDigest: string
}

export type OwnerRole = 'guest' | 'device-io' | 'host' | 'remote'

export interface Capability {
	readonly id: string
	readonly parentCapabilityId: string | null
	readonly tracksExternalOutcome: boolean
}

export interface OwnerSpec {
	readonly id: string
	readonly attestorId: string
	readonly role: OwnerRole
	readonly capabilities: readonly Capability[]
}

export interface EffectRequest {
	readonly id: string
	readonly capabilityId: string
	readonly parentEffectId: string | null
	readonly operationDigest: string
}

export type ActivationOutcome = 'accepted' | 'not-accepted' | 'activation-unknown'

export interface Reservation extends EffectRequest {
	readonly ownerId: string
	readonly sequence: number
	readonly phase: 'reserved' | 'activation-requested' | ActivationOutcome
}

export interface ActivationIntent {
	readonly boundaryDigest: string
	readonly controllerEpoch: number
	readonly reservation: Reservation
}

export interface SdkUnknown {
	readonly id: string
	readonly label: string
}

// Placement is supplied separately by the trusted controller, never by the guest's SDK record.
// Mixed, host, remote and otherwise unattributed work remains unresolved in this slice.
export interface RetainedUnknown {
	readonly original: SdkUnknown
	readonly placement: { readonly kind: 'guest-only'; readonly ownerId: string } | { readonly kind: 'unresolved' }
}

export interface StopIntent {
	readonly id: string
	readonly firstDeadlineAt: number
	readonly fenceSequence: number
	readonly proofRevision: number
	readonly challenge: string
}

export interface StopChallenge {
	readonly boundaryDigest: string
	readonly controllerEpoch: number
	readonly ownerId: string
	readonly attestorId: string
	readonly ownerScopeDigest: string
	readonly stop: StopIntent
}

export interface OwnerStopScope {
	readonly challenge: StopChallenge
	readonly reservations: readonly Reservation[]
	readonly coverableSdkUnknownIds: readonly string[]
}

export type ExternalOutcome = 'completed' | 'not-accepted' | 'cancelled-terminal' | 'unknown'

export interface EffectClosure {
	readonly effectId: string
	readonly disposition: 'never-started' | 'terminal'
	readonly externalOutcome: ExternalOutcome
}

// These are observations from a configured enforcing owner, not values a guest can submit.
// A role must join its actual work (including I/O, callbacks or delegated children) before
// reporting its terminal observation. A fence alone makes no such statement.
export type OwnerObservation =
	| { readonly kind: 'guest-stopped'; readonly enclosedSdkUnknownIds: readonly string[] }
	| { readonly kind: 'io-drained' }
	| { readonly kind: 'host-settled' }
	| { readonly kind: 'remote-terminal' }
	| { readonly kind: 'unconfirmed' }

export interface OwnerProof {
	readonly challenge: StopChallenge
	readonly fence: 'fenced' | 'unconfirmed'
	readonly observation: OwnerObservation
	readonly effects: readonly EffectClosure[]
	readonly reference: string
}

export interface OwnerPort {
	readonly spec: OwnerSpec
	// The enforcing owner admits by exact intent and epoch at its own activation point.
	// It must refuse starts after its fence, including asynchronous dispatch of an old intent.
	activate(intent: ActivationIntent): Promise<ActivationOutcome>
	// Reconcile idempotently by the retained stop ID. The deadline limits reporting, not teardown.
	closeAndDrain(scope: OwnerStopScope): Promise<OwnerProof>
}

export interface StopAssessment {
	readonly kind: 'prototype-stop-assessment'
	readonly boundaryDigest: string
	readonly controllerEpoch: number
	readonly stop: StopIntent
	readonly reservationDigest: string
	readonly ownerProofReferences: readonly { readonly ownerId: string; readonly reference: string }[]
	readonly unresolvedOwners: readonly string[]
	readonly deadlineReached: boolean
	readonly authorityFenced: boolean
	readonly ownedWritersQuiescent: boolean
	readonly originalSdkUnknowns: readonly SdkUnknown[]
	readonly unknownCoverage: readonly { readonly id: string; readonly ownerIds: readonly string[] }[]
	readonly uncoveredSdkUnknownIds: readonly string[]
	readonly externalActionOutcomes: readonly { readonly effectId: string; readonly outcome: ExternalOutcome }[]
	readonly externalActionOutcomesKnown: boolean
}

export interface BoundaryRecord {
	readonly revision: number
	readonly boundaryDigest: string
	readonly controllerEpoch: number
	readonly reservations: readonly Reservation[]
	readonly sdkUnknowns: readonly RetainedUnknown[]
	readonly stop: StopIntent | null
	readonly assessment: StopAssessment | null
}

// A single generation's journal slot. A successful CAS must be atomic and durable before
// returning. Reads and writes exchange detached snapshots. No production store is supplied.
export interface BoundaryJournal {
	read(): BoundaryRecord | undefined
	compareAndSet(expectedRevision: number | undefined, next: BoundaryRecord): boolean
	isContention?(error: unknown): boolean
}

// One trusted time domain, including when recovering a sealed stop. The first absolute
// deadline is persisted. The clock cancels only its alarm, never owner teardown.
export interface BoundaryClock {
	now(): number
	alarm(deadlineAt: number, wake: () => void): () => void
}

export function isOpaqueId(value: string): boolean {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value)
}

export function isDigest(value: string): boolean {
	return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

export function digest(parts: readonly unknown[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function ownerParts(spec: OwnerSpec) {
	return [
		spec.id,
		spec.attestorId,
		spec.role,
		spec.capabilities.map((capability) => [
			capability.id,
			capability.parentCapabilityId,
			capability.tracksExternalOutcome,
		]),
	]
}

export function boundaryDigest(identity: BoundaryIdentity, owners: readonly OwnerSpec[]): string {
	return digest([
		identity.taskId,
		identity.sessionId,
		identity.rootRunId,
		identity.generation,
		identity.boundaryId,
		identity.incarnation,
		identity.policyDigest,
		identity.imageDriverDigest,
		owners.map(ownerParts),
	])
}

export function reservationDigest(reservations: readonly Reservation[]): string {
	return digest(
		reservations.map((item) => [
			item.id,
			item.capabilityId,
			item.parentEffectId,
			item.operationDigest,
			item.ownerId,
			item.sequence,
			item.phase,
		]),
	)
}

export function describeStopScope(record: BoundaryRecord, stop: StopIntent, spec: OwnerSpec): OwnerStopScope {
	const reservations = record.reservations.filter((item) => item.ownerId === spec.id)
	const coverableSdkUnknownIds = record.sdkUnknowns
		.filter(({ placement }) => placement.kind === 'guest-only' && placement.ownerId === spec.id)
		.map(({ original }) => original.id)
	return {
		challenge: {
			boundaryDigest: record.boundaryDigest,
			controllerEpoch: record.controllerEpoch,
			ownerId: spec.id,
			attestorId: spec.attestorId,
			ownerScopeDigest: digest([ownerParts(spec), reservationDigest(reservations), coverableSdkUnknownIds]),
			stop,
		},
		reservations,
		coverableSdkUnknownIds,
	}
}

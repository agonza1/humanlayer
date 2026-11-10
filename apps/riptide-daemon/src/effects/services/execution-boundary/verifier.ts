import {
	describeStopScope,
	isOpaqueId,
	reservationDigest,
	type BoundaryRecord,
	type EffectClosure,
	type ExternalOutcome,
	type OwnerProof,
	type OwnerRole,
	type OwnerSpec,
	type OwnerStopScope,
	type StopAssessment,
	type StopChallenge,
	type StopIntent,
} from './contract'

interface OwnerCheck {
	readonly fenced: boolean
	readonly proof: OwnerProof | null
}

const terminalKind = {
	guest: 'guest-stopped',
	'device-io': 'io-drained',
	host: 'host-settled',
	remote: 'remote-terminal',
} as const satisfies Record<OwnerRole, OwnerProof['observation']['kind']>

function sameChallenge(expected: StopChallenge, observed: StopChallenge): boolean {
	return (
		observed.boundaryDigest === expected.boundaryDigest &&
		observed.controllerEpoch === expected.controllerEpoch &&
		observed.ownerId === expected.ownerId &&
		observed.attestorId === expected.attestorId &&
		observed.ownerScopeDigest === expected.ownerScopeDigest &&
		observed.stop.id === expected.stop.id &&
		observed.stop.firstDeadlineAt === expected.stop.firstDeadlineAt &&
		observed.stop.fenceSequence === expected.stop.fenceSequence &&
		observed.stop.proofRevision === expected.stop.proofRevision &&
		observed.stop.challenge === expected.stop.challenge
	)
}

function validOutcome(value: ExternalOutcome): boolean {
	return value === 'completed' || value === 'not-accepted' || value === 'cancelled-terminal' || value === 'unknown'
}

function closesReservations(scope: OwnerStopScope, effects: readonly EffectClosure[]): boolean {
	if (!Array.isArray(effects) || effects.length !== scope.reservations.length) return false
	const byId = new Map(effects.map((effect) => [effect.effectId, effect]))
	if (byId.size !== effects.length) return false

	return scope.reservations.every((reservation) => {
		const closure = byId.get(reservation.id)
		if (!closure || !validOutcome(closure.externalOutcome)) return false
		if (closure.disposition === 'never-started') {
			return reservation.phase !== 'accepted' && closure.externalOutcome === 'not-accepted'
		}
		if (closure.disposition !== 'terminal') return false
		return reservation.phase !== 'reserved' && reservation.phase !== 'not-accepted'
	})
}

function checkOwner(spec: OwnerSpec, scope: OwnerStopScope, proof: OwnerProof | undefined): OwnerCheck {
	try {
		if (
			!proof ||
			!isOpaqueId(proof.reference) ||
			!sameChallenge(scope.challenge, proof.challenge) ||
			proof.fence !== 'fenced'
		) {
			return { fenced: false, proof: null }
		}
		if (proof.observation.kind !== terminalKind[spec.role] || !closesReservations(scope, proof.effects)) {
			return { fenced: true, proof: null }
		}
		if (
			proof.observation.kind === 'guest-stopped' &&
			(!Array.isArray(proof.observation.enclosedSdkUnknownIds) ||
				!proof.observation.enclosedSdkUnknownIds.every((id) => scope.coverableSdkUnknownIds.includes(id)))
		) {
			return { fenced: true, proof: null }
		}
		return { fenced: true, proof }
	} catch {
		// Malformed observations cannot acquire authority, even on a configured channel.
		return { fenced: false, proof: null }
	}
}

// Internal composition only. The owner obtains observations from its fixed owner ports;
// there is no entry point for a guest/caller to supply a proof or mark a receipt trusted.
export function assessStop(
	record: BoundaryRecord,
	stop: StopIntent,
	specs: readonly OwnerSpec[],
	observations: ReadonlyMap<string, OwnerProof>,
	deadlineReached: boolean,
): StopAssessment {
	const checks = new Map(
		specs.map((spec) => [
			spec.id,
			checkOwner(spec, describeStopScope(record, stop, spec), observations.get(spec.id)),
		]),
	)
	const unresolvedOwners = specs.filter((spec) => !checks.get(spec.id)?.proof).map((spec) => spec.id)
	const ioOwners = specs.filter((spec) => spec.role === 'device-io')
	const ioDrained = ioOwners.length > 0 && ioOwners.every((spec) => checks.get(spec.id)?.proof)
	const unknownCoverage = record.sdkUnknowns.map(({ original, placement }) => {
		const ownerIds: string[] = []
		if (placement.kind === 'guest-only' && ioDrained) {
			const proof = checks.get(placement.ownerId)?.proof
			if (
				proof?.observation.kind === 'guest-stopped' &&
				proof.observation.enclosedSdkUnknownIds.includes(original.id)
			) {
				ownerIds.push(placement.ownerId, ...ioOwners.map((spec) => spec.id))
			}
		}
		return { id: original.id, ownerIds }
	})
	const uncoveredSdkUnknownIds = unknownCoverage.filter(({ ownerIds }) => ownerIds.length === 0).map(({ id }) => id)
	const trackedCapabilities = new Set(
		specs.flatMap((spec) =>
			spec.capabilities.filter((capability) => capability.tracksExternalOutcome).map(({ id }) => id),
		),
	)
	const outcomes = new Map<string, ExternalOutcome>()
	for (const { proof } of checks.values()) {
		for (const closure of proof?.effects ?? []) outcomes.set(closure.effectId, closure.externalOutcome)
	}
	const externalActionOutcomes = record.reservations
		.filter((reservation) => trackedCapabilities.has(reservation.capabilityId))
		.map(({ id }) => ({ effectId: id, outcome: outcomes.get(id) ?? 'unknown' }))
	const authorityFenced = specs.every((spec) => checks.get(spec.id)?.fenced)
	const ownedWritersQuiescent =
		!deadlineReached &&
		authorityFenced &&
		specs.some((spec) => spec.role === 'guest') &&
		ioDrained &&
		unresolvedOwners.length === 0 &&
		uncoveredSdkUnknownIds.length === 0

	return {
		kind: 'prototype-stop-assessment',
		boundaryDigest: record.boundaryDigest,
		controllerEpoch: record.controllerEpoch,
		stop,
		reservationDigest: reservationDigest(record.reservations),
		ownerProofReferences: Array.from(checks).flatMap(([ownerId, { proof }]) =>
			proof ? [{ ownerId, reference: proof.reference }] : [],
		),
		unresolvedOwners,
		deadlineReached,
		authorityFenced,
		ownedWritersQuiescent,
		originalSdkUnknowns: record.sdkUnknowns.map(({ original }) => original),
		unknownCoverage,
		uncoveredSdkUnknownIds,
		externalActionOutcomes,
		externalActionOutcomesKnown: externalActionOutcomes.every(({ outcome }) => outcome !== 'unknown'),
	}
}

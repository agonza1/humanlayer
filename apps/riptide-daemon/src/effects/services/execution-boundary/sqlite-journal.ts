import { Database, SQLiteError } from 'bun:sqlite'
import { closeSync, fsyncSync, lstatSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

import {
	digest,
	isDigest,
	reservationDigest,
	type ActivationIntent,
	type ActivationOutcome,
	type BoundaryJournal,
	type BoundaryRecord,
} from './contract'

const applicationId = 0x484c424a
const schemaVersion = 1

interface StoredRecord {
	readonly revision: number
	readonly boundary_digest: string
	readonly payload: string
	readonly checksum: string
}

function requirePrivatePath(path: string, kind: 'directory' | 'file'): void {
	const metadata = lstatSync(path)
	const expectedKind = kind === 'directory' ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1
	if (!expectedKind || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
		throw new Error(`Boundary journal requires an owner-only ${kind}`)
	}
}

// The supervisor owns the entire path and keeps it outside the workload's authority.
// Each file is a single generation's slot. A missing recovery file is an error.
export class SqliteBoundaryJournal implements BoundaryJournal {
	private constructor(private readonly database: Database) {}

	static create(path: string): SqliteBoundaryJournal {
		if (!isAbsolute(path)) throw new Error('Boundary journal requires an absolute path')
		const directory = dirname(path)
		requirePrivatePath(directory, 'directory')
		closeSync(openSync(path, 'wx', 0o600))
		return SqliteBoundaryJournal.connect(path, true)
	}

	static open(path: string): SqliteBoundaryJournal {
		if (!isAbsolute(path)) throw new Error('Boundary journal requires an absolute path')
		requirePrivatePath(dirname(path), 'directory')
		return SqliteBoundaryJournal.connect(path, false)
	}

	private static connect(path: string, initialize: boolean): SqliteBoundaryJournal {
		requirePrivatePath(path, 'file')
		const database = new Database(path, { create: false, readwrite: true, strict: true })
		try {
			const mode = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
			database.exec('PRAGMA synchronous = EXTRA; PRAGMA fullfsync = ON')
			const sync = database.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
			const fullsync = database.query<{ fullfsync: number }, []>('PRAGMA fullfsync').get()
			if (mode?.journal_mode !== 'delete' || sync?.synchronous !== 3 || fullsync?.fullfsync !== 1) {
				throw new Error('Boundary journal durability settings are unavailable')
			}

			if (initialize) {
				database.transaction(() =>
					database.exec(`
						CREATE TABLE boundary_record (
							slot INTEGER PRIMARY KEY CHECK (slot = 1),
							revision INTEGER NOT NULL CHECK (revision >= 0),
							boundary_digest TEXT NOT NULL,
							payload TEXT NOT NULL,
							checksum TEXT NOT NULL
						);
						CREATE TABLE boundary_dispatch (
							effect_id TEXT PRIMARY KEY NOT NULL,
							intent_digest TEXT NOT NULL
						);
						PRAGMA application_id = ${applicationId};
						PRAGMA user_version = ${schemaVersion};
					`),
				)()
				const directory = openSync(dirname(path), 'r')
				try {
					fsyncSync(directory)
				} finally {
					closeSync(directory)
				}
			}
			const app = database.query<{ application_id: number }, []>('PRAGMA application_id').get()
			const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()
			if (app?.application_id !== applicationId || version?.user_version !== schemaVersion) {
				throw new Error('Boundary journal has an unsupported format')
			}

			const journal = new SqliteBoundaryJournal(database)
			if (!initialize && !journal.read()) throw new Error('Boundary journal has no prepared generation')
			return journal
		} catch (cause) {
			database.close()
			throw cause
		}
	}

	close(): void {
		this.requireAutocommit()
		this.database.close()
	}

	isContention(error: unknown): boolean {
		return error instanceof SQLiteError && error.code === 'SQLITE_BUSY'
	}

	read(): BoundaryRecord | undefined {
		const row = this.database
			.query<StoredRecord, []>(
				'SELECT revision, boundary_digest, payload, checksum FROM boundary_record WHERE slot = 1',
			)
			.get()
		if (!row) return undefined
		if (digest([row.payload]) !== row.checksum)
			throw new Error('Boundary journal record failed its integrity check')

		const record = JSON.parse(row.payload) as BoundaryRecord
		if (record.revision !== row.revision || record.boundaryDigest !== row.boundary_digest) {
			throw new Error('Boundary journal record does not match its revision and identity')
		}
		return record
	}

	// Call at the trusted launch point. The callback must admit the work
	// synchronously, or return without giving any future launcher authority.
	dispatch(intent: ActivationIntent, launch: () => ActivationOutcome): ActivationOutcome {
		this.requireAutocommit()
		const effectId = intent.reservation.id
		const intentDigest = digest([
			intent.boundaryDigest,
			intent.controllerEpoch,
			reservationDigest([intent.reservation]),
		])
		const claim = this.database
			.transaction((): ActivationOutcome | 'claimed' => {
				const existing = this.database
					.query<{ intent_digest: string }, [string]>(
						'SELECT intent_digest FROM boundary_dispatch WHERE effect_id = ?',
					)
					.get(effectId)
				if (existing) return existing.intent_digest === intentDigest ? 'activation-unknown' : 'not-accepted'
				if (!this.admits(intent)) return 'not-accepted'
				this.database
					.query('INSERT INTO boundary_dispatch (effect_id, intent_digest) VALUES (?, ?)')
					.run(effectId, intentDigest)
				return 'claimed'
			})
			.immediate()
		if (claim !== 'claimed') return claim

		// The durable claim survives an exit during launch. The write lock
		// orders the actual admission point against the stop record's CAS.
		return this.database
			.transaction((): ActivationOutcome => {
				return this.admits(intent) ? launch() : 'not-accepted'
			})
			.immediate()
	}

	private admits(intent: ActivationIntent): boolean {
		const record = this.read()
		if (
			!record ||
			record.stop ||
			record.boundaryDigest !== intent.boundaryDigest ||
			record.controllerEpoch !== intent.controllerEpoch
		) {
			return false
		}
		const reservation = record.reservations.find(({ id }) => id === intent.reservation.id)
		if (
			reservation?.phase !== 'activation-requested' ||
			reservationDigest([reservation]) !== reservationDigest([intent.reservation])
		) {
			return false
		}
		if (reservation.parentEffectId === null) return true
		const parent = record.reservations.find(({ id }) => id === reservation.parentEffectId)
		return parent !== undefined && parent.phase !== 'reserved' && parent.phase !== 'not-accepted'
	}

	private requireAutocommit(): void {
		if (this.database.inTransaction) throw new Error('Boundary journal mutation requires an independent commit')
	}

	compareAndSet(expectedRevision: number | undefined, next: BoundaryRecord): boolean {
		this.requireAutocommit()
		if (
			(expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
			!Number.isSafeInteger(next.revision) ||
			next.revision !== (expectedRevision ?? -1) + 1 ||
			!isDigest(next.boundaryDigest)
		) {
			throw new Error('Boundary journal requires a valid identity and the next revision')
		}

		const payload = JSON.stringify(next)
		const checksum = digest([payload])
		if (expectedRevision === undefined) {
			return (
				this.database
					.query(
						`INSERT INTO boundary_record (slot, revision, boundary_digest, payload, checksum)
						VALUES (1, ?, ?, ?, ?) ON CONFLICT (slot) DO NOTHING`,
					)
					.run(next.revision, next.boundaryDigest, payload, checksum).changes === 1
			)
		}
		return (
			this.database
				.query(
					`UPDATE boundary_record SET revision = ?, payload = ?, checksum = ?
					WHERE slot = 1 AND revision = ? AND boundary_digest = ?`,
				)
				.run(next.revision, payload, checksum, expectedRevision, next.boundaryDigest).changes === 1
		)
	}
}

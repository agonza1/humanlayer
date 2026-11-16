import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'

import { digest, isDigest, reservationDigest, type ActivationIntent, type ActivationOutcome } from './contract'
import type { SqliteBoundaryJournal, SupervisorStorageIdentity } from './sqlite-journal'

export interface PrivateDarwinLaunch {
	readonly command: readonly [string, ...string[]]
	readonly workspace: { readonly path: string; readonly device: string; readonly inode: string }
	readonly uid: number
	readonly gid: number
	readonly sandboxProfile: string
	readonly env: Readonly<Record<string, string>>
	readonly driver: { readonly path: string; readonly sha256: string }
}

// Configured by the trusted supervisor only. Injected ports test admission, not privilege or containment.
export interface PrivateHandoffRuntime<Child> {
	validate(plan: PrivateDarwinLaunch, supervisorDirectory: string, storage: SupervisorStorageIdentity): boolean
	start(argv: readonly string[]): Child
}

function encloses(parent: string, child: string): boolean {
	const path = relative(parent, child)
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function validPlan(plan: PrivateDarwinLaunch, supervisorDirectory: string): boolean {
	return (
		Number.isSafeInteger(plan.uid) &&
		plan.uid > 0 &&
		plan.uid < 0xffff_fffe &&
		Number.isSafeInteger(plan.gid) &&
		plan.gid > 0 &&
		plan.gid < 0xffff_fffe &&
		isAbsolute(plan.workspace.path) &&
		/^\d+$/u.test(plan.workspace.device) &&
		/^\d+$/u.test(plan.workspace.inode) &&
		isAbsolute(plan.driver.path) &&
		isDigest(plan.driver.sha256) &&
		isAbsolute(plan.command[0]) &&
		plan.command.every((value) => !value.includes('\0')) &&
		plan.sandboxProfile.trim().length > 0 &&
		!plan.sandboxProfile.includes('\0') &&
		!encloses(plan.workspace.path, supervisorDirectory) &&
		!encloses(supervisorDirectory, plan.workspace.path) &&
		!encloses(plan.workspace.path, plan.driver.path) &&
		Object.entries(plan.env).every(
			([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !value.includes('\0'),
		)
	)
}

export function privateDarwinLaunchDigest(plan: PrivateDarwinLaunch): string {
	return digest([
		'private-darwin-handoff-v1',
		plan.command,
		plan.workspace.path,
		plan.workspace.device,
		plan.workspace.inode,
		plan.uid,
		plan.gid,
		plan.sandboxProfile,
		Object.keys(plan.env)
			.sort()
			.map((name) => [name, plan.env[name]]),
		plan.driver.path,
		plan.driver.sha256,
	])
}

export function hasNoExtendedDarwinAcl(path: string): boolean {
	if (process.platform !== 'darwin' || /[\r\n\0]/u.test(path) || !isAbsolute(path)) return false
	const listing = spawnSync('/bin/ls', ['-lde', path], {
		cwd: '/',
		env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 65_536,
	})
	// -e emits every extended ACL entry. Reject ACLs, diagnostics and unfamiliar output.
	const lines = listing.stdout?.trimEnd().split('\n')
	return (
		listing.status === 0 &&
		!listing.error &&
		listing.stderr === '' &&
		lines?.length === 1 &&
		/^[d-][rwxSsTt-]{9}@?\s/u.test(lines[0] ?? '')
	)
}

export function isProtectedPrivateDirectory(path: string): boolean {
	if (!isAbsolute(path) || realpathSync(path) !== path) return false
	for (let parent = path; ; parent = dirname(parent)) {
		const metadata = lstatSync(parent)
		if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false
		if (!hasNoExtendedDarwinAcl(parent)) return false
		if (parent === dirname(parent)) break
	}
	return true
}

export function isProtectedSupervisorStorage(directory: string, storage: SupervisorStorageIdentity): boolean {
	if (!isProtectedPrivateDirectory(directory) || dirname(storage.file.path) !== directory) return false
	const parent = lstatSync(directory)
	const file = lstatSync(storage.file.path)
	return (
		parent.dev === storage.directory.device &&
		parent.ino === storage.directory.inode &&
		(parent.mode & 0o077) === 0 &&
		realpathSync(storage.file.path) === storage.file.path &&
		file.isFile() &&
		file.uid === 0 &&
		file.nlink === 1 &&
		(file.mode & 0o077) === 0 &&
		file.dev === storage.file.device &&
		file.ino === storage.file.inode &&
		hasNoExtendedDarwinAcl(storage.file.path)
	)
}

export function isProtectedPrivateDriver(path: string, sha256: string): boolean {
	if (!isAbsolute(path) || realpathSync(path) !== path || !isProtectedPrivateDirectory(dirname(path))) return false
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const pinned = fstatSync(fd)
		if (!pinned.isFile() || pinned.uid !== 0 || (pinned.mode & 0o022) !== 0) return false
		if (!hasNoExtendedDarwinAcl(path)) return false
		const hash = createHash('sha256').update(readFileSync(fd)).digest('hex')
		const current = lstatSync(path)
		// Root owns every pathname component. Worker credentials cannot replace the hashed object.
		// Trusted supervisor installation/update must remain quiescent through this launch.
		return current.dev === pinned.dev && current.ino === pinned.ino && hash === sha256
	} finally {
		closeSync(fd)
	}
}

const nativeRuntime: PrivateHandoffRuntime<Bun.Subprocess<'ignore', 'pipe', 'pipe'>> = {
	validate(plan, supervisorDirectory, storage) {
		if (process.platform !== 'darwin' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return false
		const workspace = lstatSync(plan.workspace.path, { bigint: true })
		return (
			realpathSync(plan.workspace.path) === plan.workspace.path &&
			workspace.isDirectory() &&
			workspace.dev.toString() === plan.workspace.device &&
			workspace.ino.toString() === plan.workspace.inode &&
			workspace.uid === BigInt(plan.uid) &&
			workspace.gid === BigInt(plan.gid) &&
			(workspace.mode & 0o077n) === 0n &&
			isProtectedSupervisorStorage(supervisorDirectory, storage) &&
			isProtectedPrivateDriver(plan.driver.path, plan.driver.sha256)
		)
	},
	start(argv) {
		return Bun.spawn([...argv], {
			cwd: '/',
			env: { PATH: '/usr/bin:/bin', LANG: 'C' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		})
	},
}

export function inspectPrivateDarwinLaunch(journal: SqliteBoundaryJournal, intent: ActivationIntent) {
	const { record, state } = journal.inspectDispatch(intent)
	const stored = record?.reservations.find(({ id }) => id === intent.reservation.id)
	if (
		!record ||
		record.boundaryDigest !== intent.boundaryDigest ||
		record.controllerEpoch !== intent.controllerEpoch ||
		!stored ||
		reservationDigest([{ ...stored, phase: intent.reservation.phase }]) !== reservationDigest([intent.reservation])
	) {
		return { state: 'mismatch' as const, stop: record?.stop ?? null, revision: record?.revision }
	}
	return { state, stop: record.stop, revision: record.revision }
}

export function launchPrivateDarwinWorker<Child = Bun.Subprocess<'ignore', 'pipe', 'pipe'>>(
	journal: SqliteBoundaryJournal,
	intent: ActivationIntent,
	plan: PrivateDarwinLaunch,
	runtime:
		| PrivateHandoffRuntime<Child>
		| PrivateHandoffRuntime<Bun.Subprocess<'ignore', 'pipe', 'pipe'>> = nativeRuntime,
): { outcome: ActivationOutcome; child?: Child | Bun.Subprocess<'ignore', 'pipe', 'pipe'>; binding: ActivationIntent } {
	const launch = structuredClone(plan)
	const binding = structuredClone(intent)
	let child: Child | Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
	try {
		if (
			!validPlan(launch, journal.supervisorDirectory) ||
			binding.reservation.operationDigest !== privateDarwinLaunchDigest(launch)
		) {
			return { outcome: 'not-accepted', binding }
		}
		const outcome = journal.dispatch(binding, () => {
			if (!runtime.validate(launch, journal.supervisorDirectory, journal.supervisorStorageIdentity))
				return 'not-accepted'
			const env = {
				...launch.env,
				HL_BOUNDARY_DIGEST: binding.boundaryDigest,
				HL_CONTROLLER_EPOCH: String(binding.controllerEpoch),
				HL_EFFECT_ID: binding.reservation.id,
				HL_OWNER_ID: binding.reservation.ownerId,
				HL_EFFECT_SEQUENCE: String(binding.reservation.sequence),
				HL_OPERATION_DIGEST: binding.reservation.operationDigest,
			}
			const entries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
			child = runtime.start([
				launch.driver.path,
				'--handoff',
				String(launch.uid),
				String(launch.gid),
				launch.workspace.device,
				launch.workspace.inode,
				launch.workspace.path,
				journal.supervisorDirectory,
				launch.sandboxProfile,
				String(entries.length),
				...entries.flat(),
				'--',
				...launch.command,
			])
			return 'accepted'
		})
		return { outcome, child, binding }
	} catch {
		// A durable claim or accepted child can survive a lost reply or journal error. Never retry blindly.
		return { outcome: 'activation-unknown', child, binding }
	}
}

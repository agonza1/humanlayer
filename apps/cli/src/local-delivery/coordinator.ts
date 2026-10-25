export interface Config {
	apiOrigin: string
	sessionFile: string
	stateFile: string
	directory: string
	repository: string
	baseBranch: string
	branch: string
	initialHeadSha: string
	hostId: string
	activatedAt: number
	taskPrefix: string
	pollMs?: number
}
export interface Task {
	id: string
	name: string
	createdAt: number
}
export interface Session {
	id: string
	taskId: string | null
	directory: string
	hostId: string
	createdAt: number
	status: string
}
export interface Snapshot {
	head: string
	branch: string
	base: string
	clean: boolean
	changed: boolean
}
export interface Finding {
	scope: 'in_scope' | 'out_of_scope'
	criticality: 'critical' | 'high' | 'medium' | 'low'
	description: string
}
export interface Verdict {
	verdict: 'pass' | 'fail'
	headSha: string
	findings: Finding[]
	summary: string
}
export interface RecordState {
	taskId: string
	taskName: string
	coderId: string
	phase: 'coder' | 'qa_launching' | 'qa' | 'publishing' | 'merged' | 'paused'
	qaId?: string
	qaEventId?: string
	snapshot?: Snapshot
	verdict?: Verdict
	reason?: string
	prUrl?: string
	boardPublished?: boolean
	boardReason?: string
	reportPublished?: boolean
	reportReason?: string
}
export interface State {
	version: 1
	binding: string
	records: Record<string, RecordState>
}
export interface Adapter {
	tasks(): Promise<Task[]>
	sessions(): Promise<Session[]>
	snapshot(): Promise<Snapshot>
	uuid(): string
	launchQA(record: RecordState): Promise<void>
	qaResult(id: string): Promise<string>
	publish(record: RecordState): Promise<string>
	completeTask(record: RecordState): Promise<void>
	reportDelivery(record: RecordState): Promise<void>
}
const active = new Set([
	'ready_for_launch',
	'waiting_for_workspace',
	'launching',
	'running',
	'resuming',
	'resume_requested',
	'needs_approval',
	'waiting_for_usage_limit',
	'interrupt_requested',
])
export function binding(c: Config): string {
	return JSON.stringify([
		c.apiOrigin,
		c.directory,
		c.repository,
		c.baseBranch,
		c.branch,
		c.initialHeadSha,
		c.hostId,
		c.activatedAt,
		c.taskPrefix,
	])
}
export function initialState(c: Config): State {
	return { version: 1, binding: binding(c), records: {} }
}
export function parseVerdict(text: string): Verdict {
	const raw = text
		.trim()
		.replace(/^```(?:json)?\s*/, '')
		.replace(/\s*```$/, '')
	const v = JSON.parse(raw) as Verdict
	if (
		!v ||
		!['pass', 'fail'].includes(v.verdict) ||
		!/^[a-f0-9]{40}$/.test(v.headSha) ||
		typeof v.summary !== 'string' ||
		!Array.isArray(v.findings)
	)
		throw new Error('QA did not return the required JSON verdict')
	for (const f of v.findings)
		if (
			!['in_scope', 'out_of_scope'].includes(f.scope) ||
			!['critical', 'high', 'medium', 'low'].includes(f.criticality) ||
			typeof f.description !== 'string'
		)
			throw new Error('QA finding lacks scope or criticality')
	return v
}
function sameSnapshot(a: Snapshot, b: Snapshot) {
	return b.clean && a.head === b.head && a.branch === b.branch && a.base === b.base
}
export function deliveryResult(record: RecordState) {
	if (
		record.phase !== 'merged' ||
		!record.prUrl ||
		!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(record.prUrl) ||
		!record.snapshot ||
		!/^[a-f0-9]{40}$/.test(record.snapshot.head) ||
		record.verdict?.verdict !== 'pass' ||
		record.verdict.headSha !== record.snapshot.head ||
		record.verdict.findings.some((f) => f.scope === 'in_scope')
	)
		throw new Error('Merged delivery lacks its PR or exact-commit QA approval')
	return { status: 'merged' as const, pullRequestUrl: record.prUrl, headSha: record.snapshot.head }
}

export function deliveryReport(record: RecordState): string {
	if (record.phase !== 'merged' || !record.prUrl || !record.snapshot || !record.verdict)
		throw new Error('Merged delivery lacks its PR or QA evidence')
	const unrelated = record.verdict.findings.filter((f) => f.scope === 'out_of_scope')
	const unrelatedLines = unrelated.map((f) => '- ' + f.criticality + ': ' + f.description)
	if (!unrelatedLines.length) unrelatedLines.push('None reported.')
	return [
		'# Delivery merged',
		'',
		record.taskName,
		'',
		'Pull request: ' + record.prUrl,
		'',
		'Reviewed implementation commit: `' + record.snapshot.head + '`',
		'',
		'Independent QA: passed' + (record.qaId ? ' (session `' + record.qaId + '`)' : ''),
		'',
		record.verdict.summary,
		'',
		'## Unrelated bugs for backlog triage',
		'',
		...unrelatedLines,
		'',
	].join('\n')
}
async function reportMerged(state: State, a: Adapter, save: () => Promise<void>): Promise<void> {
	for (const record of Object.values(state.records)) {
		if (record.phase !== 'merged') continue
		if (!record.boardPublished) {
			try {
				deliveryResult(record)
				await a.completeTask(record)
				record.boardPublished = true
				record.boardReason = undefined
			} catch (error) {
				record.boardReason =
					'Delivery merged; board update pending: ' +
					(error instanceof Error ? error.message : 'task update failed')
			}
			// Idempotent task projection is independent of receipt publication.
			await save()
		}
		if (record.reportPublished) continue
		try {
			await a.reportDelivery(record)
			record.reportPublished = true
			record.reportReason = undefined
		} catch (error) {
			record.reportReason =
				'Delivery merged; receipt pending: ' +
				(error instanceof Error ? error.message : 'artifact upload failed')
		}
		// A reporting failure never changes the remote merge outcome or re-enters publication.
		await save()
	}
}

/** Every external mutation has a durable intent first. Errors pause the individual delivery. */
export async function tick(c: Config, state: State, a: Adapter, save: () => Promise<void>): Promise<void> {
	if (state.version !== 1 || state.binding !== binding(c))
		throw new Error('Delivery configuration differs from durable state; use a new state file')
	// Backfill receipts for already merged records even if no current coder session remains.
	await reportMerged(state, a, save)
	const [tasks, sessions] = await Promise.all([a.tasks(), a.sessions()])
	const local = sessions.filter((s) => s.directory === c.directory && s.hostId === c.hostId)
	const qaIds = new Set(Object.values(state.records).map((r) => r.qaId))
	for (const t of tasks) {
		if (t.createdAt < c.activatedAt || !t.name.startsWith(c.taskPrefix) || state.records[t.id]) continue
		const coders = local
			.filter((s) => s.taskId === t.id && s.createdAt >= c.activatedAt && !qaIds.has(s.id))
			.sort((x, y) => x.createdAt - y.createdAt)
		const firstCoder = coders[0]
		if (firstCoder) {
			state.records[t.id] = { taskId: t.id, taskName: t.name, coderId: firstCoder.id, phase: 'coder' }
			await save()
		}
	}
	const pending = Object.values(state.records).filter((r) => !['merged', 'paused'].includes(r.phase))
	// One shared checkout is one delivery lane. Multiple adopted tasks require operator reconciliation.
	if (pending.length > 1) {
		for (const r of pending) {
			r.phase = 'paused'
			r.reason = 'Multiple automatic tasks share this checkout; use separate worktrees'
		}
		await save()
		return
	}
	for (const r of pending) {
		try {
			if (!tasks.some((t) => t.id === r.taskId && t.name.startsWith(c.taskPrefix)))
				throw new Error('Task no longer opts into automatic delivery')
			const coder = local.find((s) => s.id === r.coderId)
			if (!coder) throw new Error('Coder session no longer exists')
			if (active.has(coder.status)) continue
			if (coder.status !== 'ready_for_input') throw new Error('Coder did not finish successfully')
			if (local.some((s) => s.id !== r.qaId && s.id !== r.coderId && active.has(s.status)))
				throw new Error('Another session is active in this checkout')
			if (r.phase === 'coder') {
				const snapshot = await a.snapshot()
				if (
					!snapshot.clean ||
					!snapshot.changed ||
					snapshot.head === c.initialHeadSha ||
					snapshot.branch !== c.branch ||
					snapshot.branch === c.baseBranch
				)
					throw new Error('Coder must commit a nonempty change on a clean feature branch')
				r.snapshot = snapshot
				r.qaId = a.uuid()
				r.qaEventId = a.uuid()
				r.phase = 'qa_launching'
				await save()
				// If this call is interrupted, the next tick reconciles its exact persisted ID, never launches another.
				try {
					await a.launchQA(r)
					r.phase = 'qa'
					r.reason = undefined
				} catch {
					r.reason =
						'QA launch response was uncertain; reconciling the persisted session ID on the next iteration'
				}
				await save()
				continue
			}
			const qa = local.find((s) => s.id === r.qaId)
			if (r.phase === 'qa_launching') {
				if (!qa)
					throw new Error(
						'QA launch outcome is uncertain; inspect the persisted QA session ID before recovery',
					)
				r.phase = 'qa'
				await save()
			}
			if (!r.snapshot) throw new Error('Missing implementation snapshot')
			if (r.phase === 'qa') {
				if (!qa) throw new Error('QA session no longer exists')
				if (active.has(qa.status)) continue
				if (qa.status !== 'ready_for_input') throw new Error('QA did not finish successfully')
				r.verdict = parseVerdict(await a.qaResult(qa.id))
				if (
					r.verdict.verdict !== 'pass' ||
					r.verdict.headSha !== r.snapshot.head ||
					r.verdict.findings.some((f) => f.scope === 'in_scope')
				)
					throw new Error('QA rejected the implementation or reviewed a different commit')
				if (!sameSnapshot(r.snapshot, await a.snapshot())) throw new Error('Checkout changed during QA')
				r.phase = 'publishing'
				await save()
			}
			if (r.phase === 'publishing') {
				if (!r.verdict || r.verdict.verdict !== 'pass' || r.verdict.headSha !== r.snapshot.head)
					throw new Error('Missing exact-commit QA approval')
				if (!sameSnapshot(r.snapshot, await a.snapshot()))
					throw new Error('Checkout changed before publication')
				r.prUrl = await a.publish(r)
				r.phase = 'merged'
				await save()
				await reportMerged(state, a, save)
			}
		} catch (error) {
			if (r.phase === 'merged') {
				r.reportReason =
					'Delivery merged; receipt state could not be saved: ' +
					(error instanceof Error ? error.message : 'state write failed')
			} else {
				r.phase = 'paused'
				r.reason = error instanceof Error ? error.message : 'Delivery failed'
			}
			await save()
		}
	}
}

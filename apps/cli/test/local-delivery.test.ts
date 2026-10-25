import { describe, expect, it } from 'vitest'

import {
	deliveryReport,
	deliveryResult,
	initialState,
	parseVerdict,
	tick,
	type Adapter,
	type Config,
	type Session,
	type Snapshot,
	type State,
} from '../src/local-delivery/coordinator'
const head = 'a'.repeat(40),
	base = 'b'.repeat(40)
const config: Config = {
	apiOrigin: 'http://127.0.0.1:51971',
	directory: '/isolated',
	sessionFile: '/private/session',
	stateFile: '/private/state',
	repository: 'owner/repo',
	baseBranch: 'main',
	branch: 'feature',
	initialHeadSha: base,
	hostId: 'host',
	activatedAt: 100,
	taskPrefix: '[auto] ',
}
function fixture() {
	let sessions: Session[] = [
		{
			id: 'coder',
			taskId: 'task',
			directory: '/isolated',
			hostId: 'host',
			createdAt: 200,
			status: 'ready_for_input',
		},
	]
	let snapshot: Snapshot = { head, base, branch: 'feature', clean: true, changed: true }
	let launches = 0,
		publishes = 0,
		reports = 0,
		completions = 0,
		id = 0
	let result = JSON.stringify({ verdict: 'pass', headSha: head, findings: [], summary: 'Checks pass' })
	const adapter: Adapter = {
		tasks: async () => [{ id: 'task', name: '[auto] Small change', createdAt: 200 }],
		sessions: async () => sessions,
		snapshot: async () => snapshot,
		uuid: () => `qa-${++id}`,
		launchQA: async (r) => {
			launches++
			sessions.push({
				id: r.qaId!,
				taskId: 'task',
				directory: '/isolated',
				hostId: 'host',
				createdAt: 300,
				status: 'running',
			})
		},
		qaResult: async () => result,
		completeTask: async () => {
			completions++
		},
		reportDelivery: async () => {
			reports++
		},
		publish: async () => {
			publishes++
			return 'https://github.com/owner/repo/pull/1'
		},
	}
	let state = initialState(config)
	let durable = JSON.stringify(state)
	const save = async () => {
		durable = JSON.stringify(state)
	}
	const step = () => tick(config, state, adapter, save)
	return {
		adapter,
		step,
		restart: () => {
			state = JSON.parse(durable) as State
		},
		get state() {
			return state
		},
		get launches() {
			return launches
		},
		get completions() {
			return completions
		},
		get reports() {
			return reports
		},
		get publishes() {
			return publishes
		},
		finish: () => {
			sessions[1]!.status = 'ready_for_input'
		},
		change: () => {
			snapshot = { ...snapshot, head: 'c'.repeat(40) }
		},
		dirty: () => {
			snapshot = { ...snapshot, clean: false }
		},
		fail: () => {
			result = JSON.stringify({
				verdict: 'fail',
				headSha: head,
				findings: [{ scope: 'in_scope', criticality: 'high', description: 'Regression' }],
				summary: 'Failure',
			})
		},
		outOfScope: () => {
			result = JSON.stringify({
				verdict: 'pass',
				headSha: head,
				findings: [{ scope: 'out_of_scope', criticality: 'high', description: 'Existing unrelated bug' }],
				summary: 'Scoped checks pass',
			})
		},
		sessions: () => sessions,
	}
}
describe('local delivery', () => {
	it('persists QA identity and merges once across restarts', async () => {
		const f = fixture()
		await f.step()
		expect(f.launches).toBe(1)
		f.restart()
		await f.step()
		expect(f.launches).toBe(1)
		f.finish()
		await f.step()
		expect(f.publishes).toBe(1)
		expect(f.state.records.task!.phase).toBe('merged')
		expect(f.state.records.task!.boardPublished).toBe(true)
		expect(f.completions).toBe(1)
		f.restart()
		await f.step()
		expect(f.publishes).toBe(1)
	})
	it('retains merged outcome after receipt failure and retries without another publication', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.adapter.reportDelivery = async () => {
			throw new Error('offline')
		}
		await f.step()
		expect(f.state.records.task!.phase).toBe('merged')
		expect(f.state.records.task!.reportReason).toContain('receipt pending')
		expect(f.state.records.task!.boardPublished).toBe(true)
		expect(f.completions).toBe(1)
		expect(f.publishes).toBe(1)
		f.restart()
		let attempts = 0
		f.adapter.reportDelivery = async () => {
			attempts++
		}
		await f.step()
		expect(attempts).toBe(1)
		expect(f.state.records.task!.reportPublished).toBe(true)
		expect(f.state.records.task!.reportReason).toBeUndefined()
		expect(f.publishes).toBe(1)
		f.restart()
		await f.step()
		expect(attempts).toBe(1)
		expect(f.publishes).toBe(1)
	})
	it('does not mislabel a completed merge when saving receipt state fails', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		let failed = false
		await tick(config, f.state, f.adapter, async () => {
			if (f.state.records.task!.reportPublished && !failed) {
				failed = true
				throw new Error('disk temporarily unavailable')
			}
		})
		expect(f.state.records.task!.phase).toBe('merged')
		expect(f.state.records.task!.reportReason).toContain('receipt state could not be saved')
		expect(f.publishes).toBe(1)
	})
	it('backfills an existing merged record without coder sessions', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		await f.step()
		delete f.state.records.task!.reportPublished
		f.sessions().length = 0
		await f.step()
		expect(f.reports).toBe(2)
		expect(f.publishes).toBe(1)
	})
	it('puts the reviewed SHA, PR and unrelated bug criticality in the receipt', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.outOfScope()
		await f.step()
		const report = deliveryReport(f.state.records.task!)
		expect(report).toContain(head)
		expect(report).toContain('https://github.com/owner/repo/pull/1')
		expect(report).toContain('high: Existing unrelated bug')
		expect(report).toContain('Scoped checks pass')
	})
	it('blocks a coder that creates no new commit after activation', async () => {
		const f = fixture()
		f.adapter.snapshot = async () => ({ head: base, base, branch: 'feature', clean: true, changed: true })
		await f.step()
		expect(f.launches).toBe(0)
		expect(f.state.records.task!.phase).toBe('paused')
	})
	it('honors withdrawn automatic delivery before publication', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.adapter.tasks = async () => []
		await f.step()
		expect(f.publishes).toBe(0)
		expect(f.state.records.task!.reason).toBe('Task no longer opts into automatic delivery')
	})
	it('blocks failed QA', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.fail()
		await f.step()
		expect(f.state.records.task!.phase).toBe('paused')
		expect(f.publishes).toBe(0)
	})
	it('blocks a changed implementation after QA', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.change()
		await f.step()
		expect(f.publishes).toBe(0)
		expect(f.state.records.task!.reason).toBe('Checkout changed during QA')
	})
	it('blocks uncommitted coder changes before launching QA', async () => {
		const f = fixture()
		f.dirty()
		await f.step()
		expect(f.launches).toBe(0)
		expect(f.state.records.task!.phase).toBe('paused')
	})
	it('keeps unrelated bugs nonblocking with criticality in durable evidence', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.outOfScope()
		await f.step()
		expect(f.publishes).toBe(1)
		expect(f.state.records.task!.verdict!.findings[0]!.criticality).toBe('high')
	})
	it('does not adopt historical tasks', async () => {
		const f = fixture()
		f.adapter.tasks = async () => [{ id: 'task', name: '[auto] Old', createdAt: 50 }]
		await f.step()
		expect(f.launches).toBe(0)
	})
	it('does not adopt another checkout', async () => {
		const f = fixture()
		f.sessions()[0]!.directory = '/other'
		await f.step()
		expect(f.launches).toBe(0)
	})
	it('waits for a queued coder instead of treating it as failed', async () => {
		const f = fixture()
		f.sessions()[0]!.status = 'ready_for_launch'
		await f.step()
		expect(f.state.records.task!.phase).toBe('coder')
		expect(f.launches).toBe(0)
	})
	it('blocks concurrent sessions in the checkout', async () => {
		const f = fixture()
		f.sessions().push({ ...f.sessions()[0]!, id: 'other', taskId: 'other', status: 'running' })
		await f.step()
		expect(f.launches).toBe(0)
		expect(f.state.records.task!.reason).toBe('Another session is active in this checkout')
	})
	it('reconciles a lost QA launch response without launching twice', async () => {
		const f = fixture()
		const launch = f.adapter.launchQA
		f.adapter.launchQA = async (r) => {
			await launch(r)
			throw new Error('lost response')
		}
		await f.step()
		expect(f.state.records.task!.phase).toBe('qa_launching')
		f.restart()
		await f.step()
		expect(f.launches).toBe(1)
		expect(f.state.records.task!.phase).toBe('qa')
	})
	it('pauses an uncertain launch that cannot be found', async () => {
		const f = fixture()
		f.adapter.launchQA = async () => {
			throw new Error('unknown')
		}
		await f.step()
		f.restart()
		await f.step()
		expect(f.state.records.task!.phase).toBe('paused')
		expect(f.launches).toBe(0)
	})
	it('reconciles publication after a process restart', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.state.records.task!.phase = 'publishing'
		f.state.records.task!.verdict = { verdict: 'pass', headSha: head, findings: [], summary: 'Pass' }
		await f.step()
		expect(f.publishes).toBe(1)
	})
	it('rejects malformed or stale QA output', () => {
		expect(() => parseVerdict('looks good')).toThrow()
		expect(() => parseVerdict('{"verdict":"pass","headSha":"x","findings":[],"summary":"ok"}')).toThrow()
	})
})

describe('board completion reconciliation', () => {
	it('retries a failed board update after restart even when receipt already published', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		f.adapter.completeTask = async () => {
			throw new Error('API offline')
		}
		await f.step()
		expect(f.state.records.task!.phase).toBe('merged')
		expect(f.state.records.task!.boardPublished).toBeUndefined()
		expect(f.state.records.task!.boardReason).toContain('board update pending')
		expect(f.state.records.task!.reportPublished).toBe(true)
		f.restart()
		let updates = 0
		f.adapter.completeTask = async () => {
			updates++
		}
		await f.step()
		expect(updates).toBe(1)
		expect(f.state.records.task!.boardPublished).toBe(true)
		expect(f.state.records.task!.boardReason).toBeUndefined()
		f.restart()
		await f.step()
		expect(updates).toBe(1)
		expect(f.publishes).toBe(1)
	})
	it('backfills legacy merged state with published receipt and no remaining sessions', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		await f.step()
		delete f.state.records.task!.boardPublished
		f.sessions().length = 0
		await f.step()
		expect(f.completions).toBe(2)
		expect(f.reports).toBe(1)
		expect(f.publishes).toBe(1)
	})
	it('never completes running or QA rejected tasks', async () => {
		const f = fixture()
		await f.step()
		expect(f.completions).toBe(0)
		f.fail()
		f.finish()
		await f.step()
		expect(f.state.records.task!.phase).toBe('paused')
		expect(f.completions).toBe(0)
	})
	it('rejects malformed legacy merged records lacking exact-commit QA evidence', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		await f.step()
		delete f.state.records.task!.boardPublished
		f.state.records.task!.verdict!.headSha = base
		expect(() => deliveryResult(f.state.records.task!)).toThrow('exact-commit QA')
		await f.step()
		expect(f.completions).toBe(1)
		expect(f.state.records.task!.boardPublished).toBeUndefined()
		expect(f.state.records.task!.boardReason).toContain('exact-commit QA')
	})
	it('replays an API success if the acknowledgement was lost before durable save', async () => {
		const f = fixture()
		await f.step()
		f.finish()
		let first = true
		f.adapter.completeTask = async () => {
			if (first) {
				first = false
				throw new Error('response lost after successful task update')
			}
		}
		await f.step()
		f.restart()
		await f.step()
		expect(f.state.records.task!.boardPublished).toBe(true)
		expect(f.publishes).toBe(1)
	})
})

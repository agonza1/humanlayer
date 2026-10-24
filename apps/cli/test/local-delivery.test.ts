import { describe, expect, it } from 'vitest'

import {
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
		f.restart()
		await f.step()
		expect(f.publishes).toBe(1)
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

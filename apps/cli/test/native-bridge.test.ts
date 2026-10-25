import { describe, expect, it } from 'vitest'

import { nativeExecutionReceipt, syncNativeExecution, type NativeBridgeAdapter } from '../src/native-bridge'

const coderThreadId = '11111111-1111-4111-8111-111111111111'
const qaThreadId = '22222222-2222-4222-8222-222222222222'
const config = {
	apiOrigin: 'http://127.0.0.1:51971',
	sessionFile: '/private/session.json',
	taskId: '33333333-3333-4333-8333-333333333333',
	repository: 'owner/repo',
	directory: '/isolated',
}
const execution = {
	mode: 'main-mediated' as const,
	stage: 'implementation' as const,
	repository: config.repository,
	directory: config.directory,
	coderThreadId,
	qaThreadId,
}
const request = { execution, artifacts: [{ fileName: 'native-request.md', content: 'Bounded implementation request' }] }
const review = { ...execution, stage: 'in_review' as const, headSha: 'a'.repeat(40) }
function fixture() {
	const task = { ownerId: 'owner', archived: false, draft: false, nativeExecution: null as unknown }
	const artifacts = new Map<string, string>()
	const events: string[] = []
	const adapter: NativeBridgeAdapter = {
		identity: async () => 'owner',
		task: async () => task,
		artifact: async (name, content) => {
			artifacts.set(name, content)
			events.push(name)
		},
		project: async (value) => {
			task.nativeExecution = value
			events.push('project')
		},
	}
	return {
		task,
		artifacts,
		events,
		adapter,
		sync: (value: unknown = request) => syncNativeExecution(config, value, adapter),
	}
}

describe('Main-mediated native execution bridge', () => {
	it('records exact native chats, artifacts and implementation phase with no dispatch or fake sessions', async () => {
		const f = fixture()
		expect(await f.sync()).toMatchObject({ stage: 'implementation', coderThreadId, qaThreadId })
		expect(f.events).toEqual(['native-request.md', 'native-execution.md', 'project'])
		expect(f.task.nativeExecution).toEqual(execution)
		expect(f.artifacts.get('native-execution.md')).toContain(`codex://threads/${coderThreadId}`)
		expect(f.artifacts.get('native-execution.md')).toContain('does not dispatch or monitor agents')
	})
	it('advances to independent QA after its result/request artifacts are saved', async () => {
		const f = fixture()
		await f.sync()
		await f.sync({
			execution: review,
			artifacts: [
				{ fileName: 'native-coder-result.md', content: 'Verified committed change' },
				{ fileName: 'native-qa-request.md', content: 'Review exact commit ' + review.headSha },
			],
		})
		expect(f.task.nativeExecution).toEqual(review)
		expect(f.events.slice(-4)).toEqual([
			'native-coder-result.md',
			'native-qa-request.md',
			'native-execution.md',
			'project',
		])
		expect(nativeExecutionReceipt(review)).toContain(review.headSha)
	})
	it('replays an interrupted artifact upload without advancing the board prematurely', async () => {
		const f = fixture()
		const upsert = f.adapter.artifact
		let first = true
		f.adapter.artifact = async (name, content) => {
			if (name === 'native-execution.md' && first) {
				first = false
				throw new Error('offline')
			}
			await upsert(name, content)
		}
		await expect(f.sync()).rejects.toThrow('offline')
		expect(f.task.nativeExecution).toBeNull()
		await f.sync()
		expect(f.artifacts.size).toBe(2)
		expect(f.task.nativeExecution).toEqual(execution)
	})
	it('replays an ambiguous task-update response idempotently', async () => {
		const f = fixture()
		const project = f.adapter.project
		let first = true
		f.adapter.project = async (value) => {
			await project(value)
			if (first) {
				first = false
				throw new Error('lost response')
			}
		}
		await expect(f.sync()).rejects.toThrow('lost response')
		await f.sync()
		expect(f.artifacts.size).toBe(2)
		expect(f.task.nativeExecution).toEqual(execution)
	})
	it('rejects a mismatched directory or repository before any mutation', async () => {
		for (const changed of [
			{ ...execution, repository: 'other/repo' },
			{ ...execution, directory: '/other' },
		]) {
			const f = fixture()
			await expect(f.sync({ ...request, execution: changed })).rejects.toThrow(
				'configured repository or directory',
			)
			expect(f.events).toEqual([])
		}
	})
	it('rejects non-owner, archived and draft tasks before artifact writes', async () => {
		for (const fields of [{ ownerId: 'stranger' }, { archived: true }, { draft: true }]) {
			const f = fixture()
			Object.assign(f.task, fields)
			await expect(f.sync()).rejects.toThrow()
			expect(f.events).toEqual([])
		}
	})
	it('rejects stale stages, rebound chats, and changed or dropped commits before artifact writes', async () => {
		const changes = [
			execution,
			{ ...review, coderThreadId: '44444444-4444-4444-8444-444444444444' },
			{ ...review, qaThreadId: '44444444-4444-4444-8444-444444444444' },
			{ ...review, headSha: 'b'.repeat(40) },
			{ ...review, headSha: undefined },
		]
		for (const changed of changes) {
			const f = fixture()
			f.task.nativeExecution = review
			await expect(f.sync({ ...request, execution: changed })).rejects.toThrow()
			expect(f.events).toEqual([])
		}
	})
	it('keeps blocked terminal but permits exact replay of the blocked snapshot', async () => {
		const f = fixture()
		f.task.nativeExecution = review
		const blocked = { ...review, stage: 'blocked', reason: 'QA identified a scoped regression' }
		await f.sync({ ...request, execution: blocked })
		await f.sync({ ...request, execution: blocked })
		f.events.length = 0
		await expect(f.sync({ ...request, execution: review })).rejects.toThrow('backwards')
		expect(f.events).toEqual([])
	})
	it('requires a distinct QA chat and exact commit for review, and a reason when blocked', async () => {
		for (const invalid of [
			{ ...execution, stage: 'in_review' },
			{ ...review, qaThreadId: coderThreadId },
			{ ...execution, stage: 'blocked' },
		]) {
			const f = fixture()
			await expect(f.sync({ ...request, execution: invalid })).rejects.toThrow()
			expect(f.events).toEqual([])
		}
	})
})

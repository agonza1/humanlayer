import { describe, expect, test } from 'vitest'

import { taskSelectSchema } from '../tables/tasks'
import { TaskNativeExecutionSchema } from './task-native-execution'

const execution = {
	mode: 'main-mediated',
	stage: 'implementation',
	repository: 'owner/repo',
	directory: '/isolated',
	coderThreadId: '11111111-1111-4111-8111-111111111111',
}
describe('native chat execution schema', () => {
	test('decodes nullable Electric JSONB while preserving exact thread IDs', () => {
		const schema = taskSelectSchema.pick({ native_execution: true })
		expect(schema.parse({ native_execution: JSON.stringify(execution) })).toEqual({ native_execution: execution })
		expect(schema.parse({ native_execution: null })).toEqual({ native_execution: null })
	})
	test('rejects invalid thread links, relative directories, unsupported modes and incomplete handoffs', () => {
		for (const invalid of [
			{ ...execution, coderThreadId: 'javascript:alert(1)' },
			{ ...execution, directory: 'relative' },
			{ ...execution, mode: 'unattended' },
			{ ...execution, stage: 'in_review' },
			{ ...execution, stage: 'blocked' },
		])
			expect(TaskNativeExecutionSchema.safeParse(invalid).success).toBe(false)
	})
})

test('rejects the same Coder/QA chat in different casing', () => {
	const id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'
	expect(
		TaskNativeExecutionSchema.safeParse({ ...execution, coderThreadId: id, qaThreadId: id.toUpperCase() }).success,
	).toBe(false)
})

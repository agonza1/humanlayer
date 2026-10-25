import { describe, expect, test } from 'vitest'

import { taskSelectSchema } from '../tables/tasks'
import { TaskDeliveryResultSchema } from './task-delivery-result'

describe('task delivery result', () => {
	const result = { status: 'merged', pullRequestUrl: 'https://github.com/owner/repo/pull/1', headSha: 'a'.repeat(40) }
	test('validates confirmed merge data and decodes Electric JSONB', () => {
		expect(TaskDeliveryResultSchema.parse(result)).toEqual(result)
		const field = taskSelectSchema.pick({ delivery_result: true })
		expect(field.parse({ delivery_result: JSON.stringify(result) })).toEqual({ delivery_result: result })
		expect(field.parse({ delivery_result: null })).toEqual({ delivery_result: null })
	})
	test('rejects incomplete, non-merged or unrecognized PR outcomes', () => {
		for (const value of [
			{ status: 'merged' },
			{ ...result, status: 'publishing' },
			{ ...result, headSha: '' },
			{ ...result, pullRequestUrl: 'https://example.com/owner/repo/pull/1' },
		]) {
			expect(TaskDeliveryResultSchema.safeParse(value).success).toBe(false)
		}
	})
})

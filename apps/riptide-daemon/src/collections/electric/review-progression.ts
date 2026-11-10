import { reviewProgressionSelectSchema } from '@humanlayer/db/tables/review-progression'
import { createElectricCollection } from '@humanlayer/sync'

import { Sentry } from '@/instrument'
import logger from '@/logger'

export type ReviewProgressionCollection = ReturnType<typeof createReviewProgressionCollection>
export function createReviewProgressionCollection(syncOrigin: string, token: string) {
	return createElectricCollection({
		schema: reviewProgressionSelectSchema,
		collectionName: 'reviewProgression',
		syncOrigin,
		syncVersion: 2,
		routePath: '/daemon/review-progression',
		headers: { 'x-daemon-authorization': token },
		shouldRetryOnFailure: true,
		logger,
		captureException: (error, { tags }) => Sentry.captureException(error, { tags }),
		getKey: (item) => item.task_id,
	})
}

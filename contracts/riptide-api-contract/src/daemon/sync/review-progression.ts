import { reviewProgressionSelectSchema } from '@humanlayer/db/tables/review-progression'

import { createSyncOutputSchema, SyncInputSchema } from '../../api/sync/shared-schemas'
import { contractBuilder } from '../../contract-builder'

export const syncDaemonReviewProgressionContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(reviewProgressionSelectSchema))

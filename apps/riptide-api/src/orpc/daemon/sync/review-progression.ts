import { reviewProgression } from '@humanlayer/db/tables/review-progression'
import { and, getTableColumns } from 'drizzle-orm'

import { buildDaemonReviewProgressionSyncWhere } from '../../../db/sync-auth'
import { buildDrizzleOrderFromSorts, buildDrizzleWhereFromExpression, SyncFilterError } from '../../../db/sync-filters'
import { daemonBase } from '../../base'

export const syncDaemonReviewProgressionProcedure = daemonBase.sync.reviewProgression.handler(
	async ({ input, context, errors }) => {
		try {
			const columns = getTableColumns(reviewProgression)
			const authWhere = buildDaemonReviewProgressionSyncWhere(context.auth)
			const clientWhere = buildDrizzleWhereFromExpression(columns, input.where, 'review_progression')
			const orderBy = buildDrizzleOrderFromSorts(columns, input.sorts, 'review_progression')
			let query = context.services.db
				.select()
				.from(reviewProgression)
				.where(and(authWhere, clientWhere))
				.$dynamic()
			if (orderBy.length > 0) query = query.orderBy(...orderBy)
			if (input.limit !== undefined) query = query.limit(input.limit)
			if (input.offset !== undefined) query = query.offset(input.offset)
			return { rows: await query }
		} catch (error) {
			if (error instanceof SyncFilterError) throw errors.BAD_REQUEST({ data: { message: error.message } })
			throw error
		}
	},
)

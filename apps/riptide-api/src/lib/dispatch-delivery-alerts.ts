import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Option } from 'effect'

import {
	finishSlackBlockerDispatch,
	validateSlackBlockerDispatch,
	type SlackBlockerDispatch,
} from '../db/delivery-blocker-alerts'
import type { AppRuntime } from '../effects/app-runtime'
import { SlackService } from '../effects/services/slack/slack.service'
import { postLocalSlackDeliveryBlocker } from './local-slack-alert-relay'

export async function dispatchDeliveryAlerts(
	db: PostgresJsDatabase,
	effectRuntime: AppRuntime,
	alerts: readonly SlackBlockerDispatch[],
) {
	for (const dispatch of alerts) {
		const { slots, attention } = await db.transaction((tx) => validateSlackBlockerDispatch(tx, dispatch))
		const unavailable = dispatch.slots.filter((slot) => !slots.includes(slot))
		if (unavailable.length) {
			await db.transaction((tx) =>
				finishSlackBlockerDispatch(
					tx,
					{ ...dispatch, slots: unavailable },
					{ kind: 'preflight', canceled: !slots.length },
				),
			)
		}
		if (!slots.length) continue
		const receipt = dispatch.relayRouteId
			? await postLocalSlackDeliveryBlocker({
					routeId: dispatch.relayRouteId,
					organizationId: dispatch.organizationId,
					ownerId: dispatch.ownerId,
					taskId: dispatch.taskId,
					alertId: dispatch.alertId,
					teamId: dispatch.teamId,
					channelId: dispatch.channelId,
					reason: dispatch.relayReason,
					standing: dispatch.standing ? { ...dispatch.standing, attention } : undefined,
				})
			: await effectRuntime.runPromise(
					Effect.gen(function* () {
						const slack = yield* SlackService
						return yield* slack.sendDeliveryBlocker(dispatch)
					}).pipe(
						Effect.timeoutOption('5 seconds'),
						Effect.map((result) => Option.getOrElse(result, () => ({ status: 'unknown' as const }))),
						Effect.catchCause(() => Effect.succeed({ status: 'unknown' as const })),
					),
				)
		await db.transaction((tx) =>
			finishSlackBlockerDispatch(tx, { ...dispatch, slots }, { kind: 'provider', result: receipt }),
		)
	}
}

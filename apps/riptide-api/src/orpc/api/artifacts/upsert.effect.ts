import { checkIfDesignDocHasOpenQuestions } from '@humanlayer/ai/design-doc-open-questions'
import { Clock, Effect } from 'effect'
import { hash } from 'ohash'

import { findDesignSession, findTaskArtifact, persistTextArtifact } from '../../../db/text-artifact'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { getTransactionId, requireTaskEditPermission } from '../../../effects/services/postgres/helpers'
import { PostgresDb } from '../../../effects/services/postgres/postgres-db.service'
import { notifyArtifactCreated } from '../../../effects/services/slack/slack.service'
import { MAX_TEXT_CONTENT_BYTES } from '../../../lib/constants'
import { normalizeSubpath } from '../../../lib/normalize-subpath'
import logger from '../../../logger'
import { effectOrpcBaseOrganizationRequired, requiresBillingEffectMiddleware } from '../../effect-base'

const DESIGN_DOCUMENT_TYPES: readonly string[] = ['design-discussion', 'design-prd', 'design-tdd']

export const upsertApiArtifactProcedure = effectOrpcBaseOrganizationRequired.artifacts.upsert
	.use(requiresBillingEffectMiddleware)
	.effect(function* ({ input, context, errors }) {
		const postgres = yield* PostgresDb
		const { organizationId, userId } = context.auth
		const { taskId, content, frontmatter, sessionId } = input

		const normalizedFileName = normalizeSubpath(input.fileName)
		const contentSizeBytes = Buffer.byteLength(content, 'utf8')

		if (contentSizeBytes > MAX_TEXT_CONTENT_BYTES) {
			return yield* Effect.fail(errors.BAD_REQUEST({ data: { message: 'Content exceeds maximum size' } }))
		}

		const contentHash = hash(content)

		const upsertResult = yield* postgres
			.transaction((tx) =>
				Effect.gen(function* () {
					const task = yield* requireTaskEditPermission(tx, { taskId, userId, organizationId })

					const taskSlug = task.slug ?? ''
					const now = yield* Clock.currentTimeMillis
					const existing = yield* tx.run(() => findTaskArtifact(tx.client, taskId, normalizedFileName))
					const result = yield* tx.run(() =>
						persistTextArtifact(
							tx.client,
							existing,
							{ ...task, slug: taskSlug },
							userId,
							{ ...input, fileName: normalizedFileName, contentHash },
							now,
						),
					)
					return { ...result, transactionId: yield* getTransactionId(tx), taskSlug }
				}),
			)
			.pipe(
				Effect.catchTags({
					TaskNotFoundError: () => Effect.fail(errors.NOT_FOUND()),
					TaskPermissionDeniedError: () =>
						Effect.fail(
							errors.FORBIDDEN({
								data: { message: 'Edit permission required to create or update artifacts' },
							}),
						),
					PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
					PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
				}),
			)

		const documentType = frontmatter?.type as string | undefined
		if (upsertResult.created) {
			yield* notifyArtifactCreated(upsertResult, {
				organizationId,
				taskId,
				actorUserId: userId,
				fileName: normalizedFileName,
				artifactType: documentType,
			}).pipe(Effect.forkDetach({ startImmediately: true }))
		}

		const publicUpsertResult = {
			artifactId: upsertResult.artifactId,
			transactionId: upsertResult.transactionId,
			created: upsertResult.created,
			versionNumber: upsertResult.versionNumber,
		}
		if (!documentType || !DESIGN_DOCUMENT_TYPES.includes(documentType) || !sessionId) {
			return publicUpsertResult
		}

		const matchingDesignSessions = yield* postgres
			.query(findDesignSession(postgres.client, sessionId, organizationId))
			.pipe(Effect.catchTags({ PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors) }))

		if (matchingDesignSessions.length === 0) {
			return publicUpsertResult
		}

		return yield* Effect.tryPromise(() => Effect.runPromise(checkIfDesignDocHasOpenQuestions(content))).pipe(
			Effect.map((questionAnalysis) => ({
				...publicUpsertResult,
				designQuestionsResolved: questionAnalysis.numOpenQuestions === 0,
			})),
			Effect.catch((error) => {
				logger.error({ error, artifactId: upsertResult.artifactId }, 'Design question inference failed')
				return Effect.succeed(publicUpsertResult)
			}),
		)
	})

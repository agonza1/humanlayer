import { createHash } from 'node:crypto'

import { checkIfDesignDocHasOpenQuestions } from '@humanlayer/ai/design-doc-open-questions'
import { artifactOperationsLog } from '@humanlayer/db/tables/artifact-operations-log'
import { artifacts } from '@humanlayer/db/tables/artifacts'
import { sessions } from '@humanlayer/db/tables/sessions'
import {
	decodeDelivery,
	DELIVERY_DIAGNOSIS_LABEL,
	DELIVERY_DIAGNOSIS_MODEL,
	DeliveryAttentionDiagnosisSchema,
	DeliveryReviewSchema,
} from '@humanlayer/schemas/zod/automatic-delivery'
import { decodeJsonColumn } from '@humanlayer/schemas/zod/decode-json-column'
import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { hash } from 'ohash'
import z from 'zod/v4'

import { authorTaskAttention } from '../../../db/author-task-attention'
import { acceptDeliveryReview, lockDeliveryTask, saveDelivery } from '../../../db/automatic-delivery'
import { getTxId } from '../../../db/get-tx-id'
import { activeTaskAttention, saveTaskAttention } from '../../../db/task-attention'
import { getTaskWithEffectivePermissions } from '../../../db/task-auth'
import { findDesignSession, findTaskArtifact, persistTextArtifact } from '../../../db/text-artifact'
import { OnboardingService } from '../../../effects/services/onboarding/onboarding.service'
import { notifyArtifactCreated } from '../../../effects/services/slack/slack.service'
import { Sentry } from '../../../instrument'
import { MAX_TEXT_CONTENT_BYTES } from '../../../lib/constants'
import { normalizeSubpath } from '../../../lib/normalize-subpath'
import { stripNullBytes } from '../../../lib/strip-null-bytes'
import logger from '../../../logger'
import { daemonBase, requiresDaemonBillingMiddleware } from '../../base'

const DESIGN_QUESTION_RESOLUTION_DOCUMENT_TYPES: readonly string[] = ['design-discussion']

// Each named sign-off is one immutable receipt per saved design revision, including after resolution.
const reviewCheckpoint =
	/^(\d+-(prd|tdd)-[a-z0-9-]+)\.(solution-review|system-design-review|program-design-review)\.([a-f0-9]{64})\.json$/
const decisionDetails = z.strictObject({
	question: z.string().trim().min(1).max(240),
	recommendation: z.string().trim().min(1).max(240),
	nextAction: z.string().trim().min(1).max(500),
})

export const upsertArtifactProcedure = daemonBase.artifacts.upsert
	.use(requiresDaemonBillingMiddleware)
	.handler(async ({ input, context, errors }) => {
		const { taskId, fileName: rawFileName, sessionId, operationType } = input
		// Postgres rejects U+0000 in text and jsonb. Strip before hashing so content_hash
		// matches the stored content (see lib/strip-null-bytes.ts).
		const content = stripNullBytes(input.content)
		const operationContents = stripNullBytes(input.operationContents)
		const frontmatter = stripNullBytes(input.frontmatter)
		const fileName = normalizeSubpath(rawFileName)
		const checkpoint = reviewCheckpoint.exec(fileName)
		const deliveryDiagnosis = sessionId && fileName === `delivery-diagnosis-${sessionId}.json`
		const { organizationId, userId } = context.auth
		const { services } = context
		const { db } = services

		// Validate content size (UTF-8 byte length) - handles multi-byte characters
		const contentBytes = Buffer.byteLength(content, 'utf8')
		if (contentBytes > MAX_TEXT_CONTENT_BYTES) {
			throw errors.BAD_REQUEST({
				data: { message: `Content size (${Math.round(contentBytes / 1024 / 1024)}MB) exceeds maximum of 10MB` },
			})
		}

		// Compute content hash server-side using ohash
		const contentHash = hash(content)

		try {
			const txResult = await db.transaction(async (tx) => {
				// 1. Lookup task and verify access via ownership OR ACL with effective permissions
				const task = await getTaskWithEffectivePermissions(tx, taskId, userId, organizationId, {
					lockForUpdate: true,
				})

				if (!task) {
					throw errors.NOT_FOUND()
				}

				// 2. Require edit permission to upsert artifacts
				if (task.effectivePermission !== 'edit') {
					throw errors.FORBIDDEN({ message: 'Edit permission required to create or update artifacts' })
				}

				const evidenceSession = async (id: string) => {
					const [writer] = await tx
						.select()
						.from(sessions)
						.where(
							and(
								eq(sessions.id, id),
								eq(sessions.organization_id, organizationId),
								eq(sessions.task_id, taskId),
								eq(sessions.host_id, context.auth.hostId),
								eq(sessions.created_by, userId),
							),
						)
						.for('no key update')
					if (!writer) throw errors.FORBIDDEN()
					return writer
				}
				const taskSlug = task.slug
				if (deliveryDiagnosis) {
					const deliveryTask = await lockDeliveryTask(tx, taskId, organizationId)
					const delivery = decodeDelivery(deliveryTask?.automatic_delivery)
					if (
						!deliveryTask ||
						deliveryTask.archived ||
						deliveryTask.is_draft ||
						deliveryTask.resource_owner_user_id !== userId ||
						delivery?.phase !== 'attention' ||
						delivery.recoveryAttempts !== 1 ||
						delivery.authorizedBy !== userId ||
						delivery.hostId !== context.auth.hostId ||
						delivery.managedSessionId !== sessionId
					)
						throw errors.FORBIDDEN()
					const diagnostician = await evidenceSession(sessionId)
					if (
						diagnostician.archived ||
						diagnostician.status !== 'running' ||
						diagnostician.resource_owner_user_id !== userId ||
						diagnostician.coding_agent !== 'codelayer' ||
						diagnostician.provider !== 'codex' ||
						diagnostician.model !== DELIVERY_DIAGNOSIS_MODEL ||
						diagnostician.effort !== 'high' ||
						!diagnostician.labels?.some((label) => label.name === DELIVERY_DIAGNOSIS_LABEL)
					)
						throw errors.FORBIDDEN()
					const parsed = contentBytes <= 4096 && decodeJsonColumn(DeliveryAttentionDiagnosisSchema, content)
					if (!parsed)
						throw errors.BAD_REQUEST({
							data: { message: 'Blocker diagnosis must contain a short reason and a next action.' },
						})
					const existing = delivery.attentionDiagnosis
					if (existing && (existing.reason !== parsed.reason || existing.nextAction !== parsed.nextAction))
						throw errors.FORBIDDEN()
					if (!existing) {
						delivery.attentionDiagnosis = parsed
						await saveDelivery(tx, deliveryTask, delivery)
					}
				}
				if (sessionId && fileName === `delivery-review-${sessionId}.json`) {
					const deliveryTask = await lockDeliveryTask(tx, taskId, organizationId)
					const delivery = decodeDelivery(deliveryTask?.automatic_delivery)
					if (deliveryTask && delivery?.phase === 'review' && sessionId === delivery.managedSessionId) {
						await evidenceSession(sessionId)
						const parsed = decodeJsonColumn(DeliveryReviewSchema, content)
						if (
							!parsed ||
							parsed.sessionId !== sessionId ||
							!(await acceptDeliveryReview(tx, deliveryTask, parsed))
						)
							throw errors.BAD_REQUEST({
								data: {
									message:
										'Could not accept review evidence. Check the designated session and exact PR heads.',
								},
							})
					}
				}
				const existingArtifact = await findTaskArtifact(tx, taskId, fileName)

				// Ordinary artifact uploads can share a filename. Only this procedure can
				// write the acceptance receipt (whose log ID is its own artifact's ID).
				let newCheckpoint = false
				if (checkpoint) {
					const [, stem, kind, gate, digest] = checkpoint
					const [receipt] = existingArtifact
						? await tx
								.select({
									hash: sql<string>`${artifactOperationsLog.operation_contents} ->> 'contentHash'`,
								})
								.from(artifactOperationsLog)
								.where(
									and(
										eq(artifactOperationsLog.id, existingArtifact.id),
										eq(artifactOperationsLog.artifact_id, existingArtifact.id),
									),
								)
						: []
					if (receipt) {
						if (receipt.hash !== contentHash || existingArtifact?.is_deleted)
							throw errors.BAD_REQUEST({
								data: { message: 'A recorded review checkpoint cannot be rewritten.' },
							})
					} else {
						if (
							!sessionId ||
							!operationType ||
							operationType === 'Read' ||
							task.resource_owner_user_id !== userId
						)
							throw errors.FORBIDDEN()
						const deliveryTask = await lockDeliveryTask(tx, taskId, organizationId)
						if (!deliveryTask || deliveryTask.archived || deliveryTask.is_draft) throw errors.FORBIDDEN()
						const delivery = decodeDelivery(deliveryTask.automatic_delivery)
						if (
							delivery?.authorizedBy === userId &&
							delivery.hostId &&
							delivery.hostId !== context.auth.hostId
						)
							throw errors.FORBIDDEN()
						const writer = await evidenceSession(sessionId)
						const type = `design-${kind}`
						if (
							writer.resource_owner_user_id !== userId ||
							writer.status !== 'running' ||
							writer.archived ||
							!writer.labels?.some((label) => label.name === `rpi:${type}`) ||
							(kind === 'prd') !== (gate === 'solution-review')
						)
							throw errors.FORBIDDEN()
						const file = `${stem}.md`
						const [design] = await tx
							.select({ frontmatter: artifacts.frontmatter, content: artifacts.content })
							.from(artifacts)
							.where(
								and(
									eq(artifacts.task_id, taskId),
									eq(artifacts.organization_id, organizationId),
									eq(artifacts.file_name, file),
									eq(artifacts.is_deleted, false),
								),
							)
							.for('share')
						const decision = contentBytes <= 8192 && decodeJsonColumn(decisionDetails, content)
						if (
							design?.frontmatter.type !== type ||
							createHash('sha256').update(design.content).digest('hex') !== digest ||
							!decision
						)
							throw errors.BAD_REQUEST({
								data: {
									message:
										'Save the matching design revision first and include the checkpoint question, recommendation and next action.',
								},
							})
						if (activeTaskAttention(deliveryTask))
							throw errors.BAD_REQUEST({
								data: {
									message: 'Resolve the current attention request before opening a new checkpoint.',
								},
							})
						newCheckpoint = true
						const { question, recommendation, nextAction } = decision
						await saveTaskAttention(
							tx,
							deliveryTask,
							authorTaskAttention(
								{
									kind: 'owner_input',
									responsible: 'Task owner',
									reason: `${question} Recommendation: ${recommendation}`,
									nextAction,
									evidence: file,
								},
								userId,
							),
							true,
						)
					}
				}

				const result = await persistTextArtifact(
					tx,
					existingArtifact,
					task,
					userId,
					{
						...input,
						fileName,
						content,
						contentHash,
						frontmatter,
						operationContents,
					},
					Date.now(),
					newCheckpoint,
				)
				return { ...result, txid: await getTxId(tx), taskSlug }
			})

			const output = {
				artifactId: txResult.artifactId,
				transactionId: txResult.txid,
				created: txResult.created,
				versionNumber: txResult.versionNumber,
			}

			// The task attention dispatcher owns external delivery for private evidence.
			if (deliveryDiagnosis || checkpoint) return output

			// Fire-and-forget onboarding artifact milestones. Each method no-ops unless
			// the artifact matches its kind (design discussion >=2 versions, structure
			// outline written, or pr-description written), so detaching unconditionally
			// is safe. Failures are swallowed to Sentry and never affect the upsert.
			const onboardingSource = 'daemon.artifacts.upsert'
			const documentType = frontmatter?.type as string | undefined
			const milestone = {
				resourceOwnerUserId: txResult.resourceOwnerUserId,
				artifactId: txResult.artifactId,
				taskId,
				fileName,
				frontmatterType: documentType,
				versionNumber: txResult.versionNumber,
			}
			services.effectRuntime.runFork(
				Effect.gen(function* () {
					const onboarding = yield* OnboardingService
					yield* onboarding.recordDesignDocIterated(milestone)
					yield* onboarding.recordStructureOutlineCreated(milestone)
					yield* onboarding.recordImplementationComplete(milestone)
				}).pipe(
					Effect.catch((err) =>
						Effect.sync(() => {
							Sentry.captureException(err, {
								tags: { error_type: 'onboarding_detached_failure', source: onboardingSource },
								extra: {
									userId: txResult.resourceOwnerUserId,
									artifactId: txResult.artifactId,
									source: onboardingSource,
								},
							})
						}),
					),
				),
			)

			if (txResult.created)
				services.effectRuntime.runFork(
					notifyArtifactCreated(txResult, {
						organizationId,
						taskId,
						actorUserId: userId,
						fileName,
						artifactType: documentType,
					}),
				)

			if (!sessionId || !documentType || !DESIGN_QUESTION_RESOLUTION_DOCUMENT_TYPES.includes(documentType))
				return output
			const [designSession] = await findDesignSession(db, sessionId, organizationId)

			if (!designSession) {
				return output
			}

			try {
				const questionCount = await Effect.runPromise(checkIfDesignDocHasOpenQuestions(content))
				return {
					...output,
					designQuestionsResolved: questionCount.numOpenQuestions === 0,
				}
			} catch (error) {
				logger.error({ error, artifactId: txResult.artifactId }, 'Design question inference failed')
				Sentry.addBreadcrumb({
					category: 'ai-inference',
					message: 'Design question inference failed during artifact upsert',
					level: 'error',
					data: {
						artifactId: txResult.artifactId,
						taskId,
					},
				})
				Sentry.captureException(error, {
					tags: { error_type: 'design_question_inference' },
					extra: {
						artifactId: txResult.artifactId,
						taskId,
					},
				})

				return output
			}
		} catch (error: unknown) {
			if (deliveryDiagnosis) {
				logger.warn({ taskId, sessionId }, 'Failed to record the private delivery blocker diagnosis')
			} else {
				logger.error(error, 'Failed to upsert artifact')
			}
			throw error
		}
	})

ALTER TABLE "review_progression" ADD COLUMN "consumed_revision" bigint DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "claim_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "claimed_revision" bigint;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "claim_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "continuation" jsonb DEFAULT '{"kind":"stop"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "next_wake_at" bigint;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "verified_pr_binding" jsonb;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "last_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "review_progression" ADD COLUMN "last_ack" jsonb;--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_claim_tuple" CHECK (("review_progression"."claim_id" is null and "review_progression"."claimed_revision" is null and "review_progression"."claim_expires_at" is null) or ("review_progression"."claim_id" is not null and "review_progression"."claimed_revision" is not null and "review_progression"."claim_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_revision_bounds" CHECK ("review_progression"."wake_revision" >= 0 and "review_progression"."consumed_revision" >= -1 and "review_progression"."consumed_revision" <= "review_progression"."wake_revision" and "review_progression"."claim_generation" >= 0 and ("review_progression"."claimed_revision" is null or ("review_progression"."claimed_revision" >= 0 and "review_progression"."claimed_revision" <= "review_progression"."wake_revision")));
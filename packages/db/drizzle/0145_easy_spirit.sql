ALTER TABLE "project" ADD COLUMN "delivery_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delivery_snapshot" jsonb;
CREATE TABLE "review_progression" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_owner_user_id" text NOT NULL,
	"host_id" text NOT NULL,
	"source_session_id" uuid NOT NULL,
	"enrollment_id" text NOT NULL,
	"return_route_ref" text NOT NULL,
	"placement" jsonb NOT NULL,
	"accepted_launch_digest" text NOT NULL,
	"accepted_launch" jsonb NOT NULL,
	"scope_inputs" jsonb NOT NULL,
	"verified_binding" jsonb,
	"binding_digest" text,
	"stage" text DEFAULT 'awaiting_delivery' NOT NULL,
	"planning_suspended" boolean DEFAULT false NOT NULL,
	"wake_revision" bigint DEFAULT 0 NOT NULL,
	"action_id" uuid,
	"workflow_mutation_receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"writer_receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"admitted_execution" jsonb,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "review_progression_binding_pair" CHECK (("review_progression"."verified_binding" is null) = ("review_progression"."binding_digest" is null)),
	CONSTRAINT "review_progression_launch_digest" CHECK ("review_progression"."accepted_launch_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_phase" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_phase_at" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workflow_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_progression" ADD CONSTRAINT "review_progression_org_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_progression_org_host_idx" ON "review_progression" USING btree ("organization_id","host_id");--> statement-breakpoint
CREATE INDEX "review_progression_source_session_idx" ON "review_progression" USING btree ("source_session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_execution_phase" CHECK ("sessions"."execution_phase" is null or "sessions"."execution_phase" in ('implementation', 'review'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workflow_revision_nonnegative" CHECK ("tasks"."workflow_revision" >= 0);
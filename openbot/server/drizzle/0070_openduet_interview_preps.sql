CREATE TABLE "openduet_interview_preps" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"status" text NOT NULL,
	"content" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_interview_preps_status_check" CHECK ("openduet_interview_preps"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "openduet_interview_preps_ready_check" CHECK ("openduet_interview_preps"."status" <> 'ready' OR "openduet_interview_preps"."content" IS NOT NULL),
	CONSTRAINT "openduet_interview_preps_attempts_check" CHECK ("openduet_interview_preps"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "openduet_interview_preps" ADD CONSTRAINT "openduet_interview_preps_item_id_openduet_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."openduet_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_interview_preps" ADD CONSTRAINT "openduet_interview_preps_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_interview_preps" ADD CONSTRAINT "openduet_interview_preps_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_interview_preps_item_idx" ON "openduet_interview_preps" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "openduet_interview_preps_owner_status_idx" ON "openduet_interview_preps" USING btree ("owner_user_id","status");
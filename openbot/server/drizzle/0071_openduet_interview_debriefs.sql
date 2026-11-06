CREATE TABLE "openduet_interview_debriefs" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"anarlog_meeting_id" text NOT NULL,
	"status" text NOT NULL,
	"content" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_interview_debriefs_status_check" CHECK ("openduet_interview_debriefs"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "openduet_interview_debriefs_ready_check" CHECK ("openduet_interview_debriefs"."status" <> 'ready' OR "openduet_interview_debriefs"."content" IS NOT NULL),
	CONSTRAINT "openduet_interview_debriefs_attempts_check" CHECK ("openduet_interview_debriefs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "openduet_mission_events" DROP CONSTRAINT "openduet_mission_events_type_check";--> statement-breakpoint
ALTER TABLE "openduet_interview_debriefs" ADD CONSTRAINT "openduet_interview_debriefs_item_id_openduet_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."openduet_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_interview_debriefs" ADD CONSTRAINT "openduet_interview_debriefs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_interview_debriefs" ADD CONSTRAINT "openduet_interview_debriefs_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_interview_debriefs_item_idx" ON "openduet_interview_debriefs" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_interview_debriefs_owner_meeting_idx" ON "openduet_interview_debriefs" USING btree ("owner_user_id","anarlog_meeting_id");--> statement-breakpoint
CREATE INDEX "openduet_interview_debriefs_owner_status_idx" ON "openduet_interview_debriefs" USING btree ("owner_user_id","status");--> statement-breakpoint
ALTER TABLE "openduet_mission_events" ADD CONSTRAINT "openduet_mission_events_type_check" CHECK ("openduet_mission_events"."type" IN ('stage', 'inbound', 'relance_sent', 'debrief'));
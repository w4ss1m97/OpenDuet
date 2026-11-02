CREATE TABLE "openduet_mail_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"mission_id" text,
	"relance_id" text,
	"offer_id" text,
	"to_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"thread_id" text,
	"attachment_pdf" "bytea",
	"attachment_name" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"gmail_draft_id" text,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_mail_drafts_kind_check" CHECK ("openduet_mail_drafts"."kind" IN ('relance', 'application')),
	CONSTRAINT "openduet_mail_drafts_status_check" CHECK ("openduet_mail_drafts"."status" IN ('draft', 'pushed', 'dismissed')),
	CONSTRAINT "openduet_mail_drafts_relance_check" CHECK ("openduet_mail_drafts"."kind" <> 'relance' OR "openduet_mail_drafts"."mission_id" IS NOT NULL),
	CONSTRAINT "openduet_mail_drafts_application_check" CHECK ("openduet_mail_drafts"."kind" <> 'application' OR "openduet_mail_drafts"."offer_id" IS NOT NULL),
	CONSTRAINT "openduet_mail_drafts_pushed_check" CHECK ("openduet_mail_drafts"."status" <> 'pushed' OR ("openduet_mail_drafts"."gmail_draft_id" IS NOT NULL AND "openduet_mail_drafts"."pushed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "openduet_mail_drafts" ADD CONSTRAINT "openduet_mail_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mail_drafts" ADD CONSTRAINT "openduet_mail_drafts_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mail_drafts" ADD CONSTRAINT "openduet_mail_drafts_relance_id_openduet_mission_relances_id_fk" FOREIGN KEY ("relance_id") REFERENCES "public"."openduet_mission_relances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mail_drafts" ADD CONSTRAINT "openduet_mail_drafts_offer_id_openduet_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."openduet_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openduet_mail_drafts_owner_status_idx" ON "openduet_mail_drafts" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_mail_drafts_live_relance_idx" ON "openduet_mail_drafts" USING btree ("owner_user_id","relance_id") WHERE "openduet_mail_drafts"."status" = 'draft' AND "openduet_mail_drafts"."relance_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_mail_drafts_live_application_idx" ON "openduet_mail_drafts" USING btree ("owner_user_id","offer_id") WHERE "openduet_mail_drafts"."status" = 'draft' AND "openduet_mail_drafts"."kind" = 'application';
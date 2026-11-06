CREATE TABLE "openduet_mission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"type" text NOT NULL,
	"from_stage" text,
	"to_stage" text,
	"source" text NOT NULL,
	"source_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_mission_events_type_check" CHECK ("openduet_mission_events"."type" IN ('stage', 'inbound', 'relance_sent')),
	CONSTRAINT "openduet_mission_events_source_check" CHECK ("openduet_mission_events"."source" IN ('mail', 'chat', 'app'))
);
--> statement-breakpoint
CREATE TABLE "openduet_mission_relances" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_mission_relances_status_check" CHECK ("openduet_mission_relances"."status" IN ('draft', 'sent', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "openduet_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"company" text NOT NULL,
	"role" text,
	"company_key" text NOT NULL,
	"role_key" text DEFAULT '' NOT NULL,
	"stage" text NOT NULL,
	"review" text NOT NULL,
	"title" text NOT NULL,
	"thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_missions_stage_check" CHECK ("openduet_missions"."stage" IN ('piste', 'applied', 'talking', 'interview', 'offer', 'signed', 'refused')),
	CONSTRAINT "openduet_missions_review_check" CHECK ("openduet_missions"."review" IN ('proposed', 'active', 'dismissed')),
	CONSTRAINT "openduet_missions_closed_check" CHECK (("openduet_missions"."stage" IN ('signed', 'refused')) = ("openduet_missions"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "openduet_items" ADD COLUMN "mission_id" text;--> statement-breakpoint
ALTER TABLE "openduet_mission_events" ADD CONSTRAINT "openduet_mission_events_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mission_events" ADD CONSTRAINT "openduet_mission_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mission_relances" ADD CONSTRAINT "openduet_mission_relances_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_mission_relances" ADD CONSTRAINT "openduet_mission_relances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_missions" ADD CONSTRAINT "openduet_missions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_mission_events_mission_source_hash_idx" ON "openduet_mission_events" USING btree ("mission_id","source_hash");--> statement-breakpoint
CREATE INDEX "openduet_mission_events_mission_at_idx" ON "openduet_mission_events" USING btree ("mission_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_mission_relances_mission_window_idx" ON "openduet_mission_relances" USING btree ("mission_id","window_start");--> statement-breakpoint
CREATE INDEX "openduet_missions_owner_review_stage_idx" ON "openduet_missions" USING btree ("owner_user_id","review","stage");--> statement-breakpoint
CREATE INDEX "openduet_missions_thread_ids_idx" ON "openduet_missions" USING gin ("thread_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_missions_open_company_role_idx" ON "openduet_missions" USING btree ("owner_user_id","company_key","role_key") WHERE "openduet_missions"."company_key" <> '' AND "openduet_missions"."stage" NOT IN ('signed', 'refused') AND "openduet_missions"."review" <> 'dismissed';--> statement-breakpoint
ALTER TABLE "openduet_items" ADD CONSTRAINT "openduet_items_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openduet_items_mission_idx" ON "openduet_items" USING btree ("mission_id");--> statement-breakpoint
ALTER TABLE "openduet_items" ADD CONSTRAINT "openduet_items_mission_kind_check" CHECK ("openduet_items"."mission_id" IS NULL OR "openduet_items"."kind" IN ('interview', 'followup'));
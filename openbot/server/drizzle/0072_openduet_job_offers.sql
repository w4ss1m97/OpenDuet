CREATE TABLE "openduet_offer_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_key" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"offers_found" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"paste_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_offer_sources_status_check" CHECK ("openduet_offer_sources"."status" IN ('pending', 'done', 'failed', 'skipped')),
	CONSTRAINT "openduet_offer_sources_attempts_check" CHECK ("openduet_offer_sources"."attempts" >= 0),
	CONSTRAINT "openduet_offer_sources_found_check" CHECK ("openduet_offer_sources"."offers_found" >= 0)
);
--> statement-breakpoint
CREATE TABLE "openduet_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_id" text,
	"dedup_key" text NOT NULL,
	"platform" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"company" text,
	"tjm_min" integer,
	"tjm_max" integer,
	"rate_unit" text DEFAULT 'unknown' NOT NULL,
	"contract" text DEFAULT 'unknown' NOT NULL,
	"remote" text DEFAULT 'unknown' NOT NULL,
	"location" text,
	"duration_months" integer,
	"start_asap" boolean DEFAULT false NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"status" text DEFAULT 'new' NOT NULL,
	"filter_reason" text,
	"tjm_unknown" boolean DEFAULT false NOT NULL,
	"score" integer,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"profile_hash" text,
	"score_attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"scored_at" timestamp with time zone,
	"mission_id" text,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_offers_status_check" CHECK ("openduet_offers"."status" IN ('new', 'scored', 'shown', 'filtered', 'dismissed', 'applied')),
	CONSTRAINT "openduet_offers_filter_reason_check" CHECK ("openduet_offers"."filter_reason" IS NULL OR "openduet_offers"."filter_reason" IN ('salaried', 'low_tjm', 'outside_idf')),
	CONSTRAINT "openduet_offers_rate_unit_check" CHECK ("openduet_offers"."rate_unit" IN ('day', 'hour', 'year', 'unknown')),
	CONSTRAINT "openduet_offers_contract_check" CHECK ("openduet_offers"."contract" IN ('freelance', 'salaried', 'unknown')),
	CONSTRAINT "openduet_offers_remote_check" CHECK ("openduet_offers"."remote" IN ('full', 'hybrid', 'onsite', 'unknown')),
	CONSTRAINT "openduet_offers_score_check" CHECK ("openduet_offers"."score" IS NULL OR ("openduet_offers"."score" >= 0 AND "openduet_offers"."score" <= 100)),
	CONSTRAINT "openduet_offers_score_attempts_check" CHECK ("openduet_offers"."score_attempts" >= 0),
	CONSTRAINT "openduet_offers_seen_count_check" CHECK ("openduet_offers"."seen_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "openduet_offer_sources" ADD CONSTRAINT "openduet_offer_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_offers" ADD CONSTRAINT "openduet_offers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_offers" ADD CONSTRAINT "openduet_offers_source_id_openduet_offer_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."openduet_offer_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_offers" ADD CONSTRAINT "openduet_offers_mission_id_openduet_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."openduet_missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_offer_sources_owner_key_idx" ON "openduet_offer_sources" USING btree ("owner_user_id","source_key");--> statement-breakpoint
CREATE INDEX "openduet_offer_sources_owner_status_idx" ON "openduet_offer_sources" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_offers_owner_dedup_idx" ON "openduet_offers" USING btree ("owner_user_id","dedup_key");--> statement-breakpoint
CREATE INDEX "openduet_offers_owner_status_score_idx" ON "openduet_offers" USING btree ("owner_user_id","status","score");
CREATE TABLE "openduet_cv_masters" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openduet_cv_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" jsonb,
	"match" jsonb,
	"master_hash" text,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_cv_versions_status_check" CHECK ("openduet_cv_versions"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "openduet_cv_versions_ready_check" CHECK ("openduet_cv_versions"."status" <> 'ready' OR ("openduet_cv_versions"."content" IS NOT NULL AND "openduet_cv_versions"."match" IS NOT NULL AND "openduet_cv_versions"."generated_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "openduet_cv_masters" ADD CONSTRAINT "openduet_cv_masters_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_cv_versions" ADD CONSTRAINT "openduet_cv_versions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_cv_versions" ADD CONSTRAINT "openduet_cv_versions_offer_id_openduet_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."openduet_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_cv_versions_owner_offer_idx" ON "openduet_cv_versions" USING btree ("owner_user_id","offer_id");
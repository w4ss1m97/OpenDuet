CREATE TABLE "openduet_revision_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"topic" text NOT NULL,
	"skill_group_id" text,
	"offer_id" text,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"key_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bullet_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"master_hash" text NOT NULL,
	"dedup_key" text NOT NULL,
	"box" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone,
	"review_count" integer DEFAULT 0 NOT NULL,
	"last_grade" text,
	"last_reviewed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_revision_cards_kind_check" CHECK ("openduet_revision_cards"."kind" IN ('concept', 'story', 'pitch')),
	CONSTRAINT "openduet_revision_cards_box_check" CHECK ("openduet_revision_cards"."box" BETWEEN 1 AND 5),
	CONSTRAINT "openduet_revision_cards_review_count_check" CHECK ("openduet_revision_cards"."review_count" >= 0),
	CONSTRAINT "openduet_revision_cards_grade_check" CHECK ("openduet_revision_cards"."last_grade" IS NULL OR "openduet_revision_cards"."last_grade" IN ('again', 'hard', 'good')),
	CONSTRAINT "openduet_revision_cards_story_check" CHECK ("openduet_revision_cards"."kind" <> 'story' OR cardinality("openduet_revision_cards"."bullet_ids") >= 1)
);
--> statement-breakpoint
ALTER TABLE "openduet_revision_cards" ADD CONSTRAINT "openduet_revision_cards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_revision_cards" ADD CONSTRAINT "openduet_revision_cards_offer_id_openduet_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."openduet_offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_revision_cards_owner_dedup_idx" ON "openduet_revision_cards" USING btree ("owner_user_id","dedup_key");--> statement-breakpoint
CREATE INDEX "openduet_revision_cards_owner_due_idx" ON "openduet_revision_cards" USING btree ("owner_user_id","archived_at","due_at");
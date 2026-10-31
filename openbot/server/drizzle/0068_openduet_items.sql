CREATE TABLE "openduet_intake_cursors" (
	"owner_user_id" text NOT NULL,
	"scanner" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_intake_cursors_owner_user_id_scanner_pk" PRIMARY KEY("owner_user_id","scanner"),
	CONSTRAINT "openduet_intake_cursors_scanner_check" CHECK ("openduet_intake_cursors"."scanner" IN ('mail', 'calendar', 'notes', 'projects'))
);
--> statement-breakpoint
CREATE TABLE "openduet_items" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why" text,
	"due_at" timestamp with time zone,
	"remind_at" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"amount" numeric(12, 2),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"channel_id" text,
	"source_app" text NOT NULL,
	"source_link" text,
	"source_hash" text NOT NULL,
	"status" text NOT NULL,
	"task_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_items_kind_check" CHECK ("openduet_items"."kind" IN ('interview', 'followup', 'bill', 'fine', 'deadline', 'idea', 'todo', 'project_status')),
	CONSTRAINT "openduet_items_status_check" CHECK ("openduet_items"."status" IN ('proposed', 'active', 'done', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "openduet_intake_cursors" ADD CONSTRAINT "openduet_intake_cursors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_items" ADD CONSTRAINT "openduet_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_items" ADD CONSTRAINT "openduet_items_task_id_openduet_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."openduet_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openduet_items_owner_source_hash_idx" ON "openduet_items" USING btree ("owner_user_id","source_hash");--> statement-breakpoint
CREATE INDEX "openduet_items_owner_status_due_idx" ON "openduet_items" USING btree ("owner_user_id","status","due_at");
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"title" text,
	"topic_tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wing" text NOT NULL,
	"hall" text NOT NULL,
	"room" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(3072),
	"metadata" jsonb,
	"token_count" integer NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"embedding" vector(3072),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"feedback_type" text NOT NULL,
	"original_response" text,
	"user_correction" text,
	"analysis" text,
	"error_category" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(3072),
	"topic_tags" jsonb DEFAULT '[]'::jsonb,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_id" uuid,
	"object_value" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"source" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"learned_from" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim" text NOT NULL,
	"verdict" text NOT NULL,
	"explanation" text NOT NULL,
	"sources" jsonb,
	"confidence" real NOT NULL,
	"embedding" vector(3072),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_subject_id_entities_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_object_id_entities_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drawers_content_hash_idx" ON "drawers" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "drawers_wing_hall_room_idx" ON "drawers" USING btree ("wing","hall","room");--> statement-breakpoint
CREATE INDEX "drawers_wing_idx" ON "drawers" USING btree ("wing");--> statement-breakpoint
CREATE INDEX "drawers_room_idx" ON "drawers" USING btree ("room");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_name_type_idx" ON "entities" USING btree ("name","entity_type");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "triples_subject_predicate_idx" ON "triples" USING btree ("subject_id","predicate");--> statement-breakpoint
CREATE INDEX "triples_object_idx" ON "triples" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "triples_current_idx" ON "triples" USING btree ("subject_id","predicate") WHERE "triples"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_prefs_unique_idx" ON "user_preferences" USING btree ("user_id","category","key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_idx" ON "users" USING btree ("external_id");
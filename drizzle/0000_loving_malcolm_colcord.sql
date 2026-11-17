CREATE TYPE "public"."lead_status" AS ENUM('queued', 'invite_sent', 'already_connected', 'accepted', 'messaged', 'followup_1', 'followup_2', 'replied', 'no_response', 'invite_expired', 'failed');--> statement-breakpoint
CREATE TABLE "app_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"running" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"invites_paused_until" timestamp with time zone,
	"messages_paused_until" timestamp with time zone,
	"next_invite_poll_at" timestamp with time zone,
	"tick_lock_until" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"linkedin_url" text NOT NULL,
	"provider_id" text,
	"public_identifier" text,
	"first_name" text,
	"last_name" text,
	"headline" text,
	"company" text,
	"position" text,
	"location" text,
	"status" "lead_status" DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"failed_from_status" "lead_status",
	"retry_count" integer DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"invitation_id" text,
	"chat_id" text,
	"acceptance_check_pending" boolean DEFAULT false NOT NULL,
	"invite_sent_at" timestamp with time zone,
	"sequence_started_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"last_action_at" timestamp with time zone,
	"last_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_type_created_at_idx" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_slug_lower_unique" ON "leads" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "leads_status_next_action_idx" ON "leads" USING btree ("status","next_action_at");
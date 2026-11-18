ALTER TABLE "leads" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "draft_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "invite_note_draft" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_message_draft" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "draft_error" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "draft_claimed_at" timestamp with time zone;
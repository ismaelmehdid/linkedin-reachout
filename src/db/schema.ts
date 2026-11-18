import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const leadStatus = pgEnum('lead_status', [
  'queued',
  'invite_sent',
  'already_connected',
  'accepted',
  'messaged',
  'followup_1',
  'followup_2',
  'replied',
  'no_response',
  'invite_expired',
  'failed',
]);

export type LeadStatus = (typeof leadStatus.enumValues)[number];

export type EventType =
  | 'profile_view'
  | 'invite_sent'
  | 'message_sent'
  | 'invite_withdrawn'
  | 'invite_missing'
  | 'webhook_received'
  | 'action_failed';

/**
 * Where a lead's AI-written drafts stand. `none`: a lead pasted as a URL, which uses the templates.
 * An uploaded founder starts `pending`. `ready` is written by the AI and not yet read; `approved` is
 * approved or edited by the owner. Only `none` and `approved` leads are ever invited.
 */
export const DRAFT_STATUSES = ['none', 'pending', 'generating', 'ready', 'approved', 'failed'] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** A job of the founder's company, as uploaded. */
export type LeadContextJob = {
  title: string;
  category: string | null;
  location: string | null;
  remote: string | null;
  salary: string | null;
  equity: string | null;
  url: string | null;
  /** Cut to its first characters at upload. */
  description: string;
};

/** What the upload knows about a founder and their company: the AI writes the drafts from it. */
export type LeadContext = {
  founder: { name: string; bio: string | null; pastCompanies: string | null };
  company: {
    name: string;
    batch: string | null;
    website: string | null;
    oneLiner: string | null;
    description: string | null;
    teamSize: number | null;
    jobs: LeadContextJob[];
  };
};

export type LastAction =
  | 'invite_sent'
  | 'already_connected'
  | 'accepted'
  | 'first_message'
  | 'followup_1'
  | 'followup_2'
  | 'reply_received'
  | 'manual_message'
  | 'no_response'
  | 'invite_withdrawn'
  | 'invite_gone'
  | 'failed';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const leads = pgTable(
  'leads',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    linkedinUrl: text('linkedin_url').notNull(),
    providerId: text('provider_id').unique(),
    publicIdentifier: text('public_identifier'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    headline: text('headline'),
    company: text('company'),
    position: text('position'),
    location: text('location'),
    status: leadStatus('status').notNull().default('queued'),
    failureReason: text('failure_reason'),
    failedFromStatus: leadStatus('failed_from_status'),
    retryCount: integer('retry_count').notNull().default(0),
    paused: boolean('paused').notNull().default(false),
    invitationId: text('invitation_id'),
    chatId: text('chat_id'),
    acceptanceCheckPending: boolean('acceptance_check_pending').notNull().default(false),
    inviteSentAt: timestamptz('invite_sent_at'),
    sequenceStartedAt: timestamptz('sequence_started_at'),
    nextActionAt: timestamptz('next_action_at'),
    lastActionAt: timestamptz('last_action_at'),
    lastAction: text('last_action').$type<LastAction>(),
    /** Null for a lead pasted as a URL. */
    context: jsonb('context').$type<LeadContext>(),
    draftStatus: text('draft_status').$type<DraftStatus>().notNull().default('none'),
    inviteNoteDraft: text('invite_note_draft'),
    firstMessageDraft: text('first_message_draft'),
    /** Why the last generation failed. */
    draftError: text('draft_error'),
    /** When a generation took the lead, so that a run that died can be taken again. */
    draftClaimedAt: timestamptz('draft_claimed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leads_slug_lower_unique').on(sql`lower(${t.slug})`),
    index('leads_status_next_action_idx').on(t.status, t.nextActionAt),
  ],
);

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    leadId: integer('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    type: text('type').$type<EventType>().notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('events_type_created_at_idx').on(t.type, t.createdAt)],
);

export const settingsTable = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  value: jsonb('value').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const appStateTable = pgTable('app_state', {
  id: integer('id').primaryKey().default(1),
  running: boolean('running').notNull().default(false),
  pauseReason: text('pause_reason'),
  invitesPausedUntil: timestamptz('invites_paused_until'),
  messagesPausedUntil: timestamptz('messages_paused_until'),
  nextInvitePollAt: timestamptz('next_invite_poll_at'),
  tickLockUntil: timestamptz('tick_lock_until'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  /** The earliest moment of the next invite or message (spec §8 "Spacing"). Null until the first tick plans one. */
  nextOutreachAt: timestamptz('next_outreach_at'),
  /** The earliest moment of the next invite withdrawal. Null until the first withdrawal. */
  nextWithdrawalAt: timestamptz('next_withdrawal_at'),
});

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type EventRow = typeof events.$inferSelect;

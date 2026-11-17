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
  | 'webhook_received'
  | 'action_failed';

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
});

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type EventRow = typeof events.$inferSelect;

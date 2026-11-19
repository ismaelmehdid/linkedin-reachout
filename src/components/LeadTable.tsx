'use client';

import Link from 'next/link';
import { Fragment, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { pauseLeadAction, removeLeadAction, resumeLeadAction, retryLeadAction } from '@/app/actions';
import { approveDraftAction, regenerateDraftAction, saveDraftAction } from '@/app/drafts/actions';
import { INVITE_NOTE_MAX_LENGTH } from '@/lib/templates/render';
import {
  canEditFirstMessage,
  canEditInviteNote,
  canRegenerate,
  canReview,
  noteLength,
  noteNotSentNotice,
  noteTooLong,
  readyNotePreview,
} from './draft-review';

/** One table row, with its dates already formatted in the active window's timezone. */
export type LeadRow = {
  id: number;
  name: string;
  headline: string | null;
  role: string | null;
  linkedinUrl: string;
  status: string;
  failureReason: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  paused: boolean;
  /** `none` for a pasted lead, which uses the templates. */
  draftStatus: string;
  draftError: string | null;
  inviteNoteDraft: string | null;
  firstMessageDraft: string | null;
};

/** A line under the Draft cell, kept by the row: the editor below it remounts when the draft changes. */
type Feedback = { kind: 'error' | 'info'; lines: string[] };

const REGENERATED = 'Sent back to pending. Press Generate drafts to write it again.';
const CHANGED_SINCE_OPENED = 'This draft changed since you opened it. Review it again.';

const REMOVE_CONFIRMATION = 'Remove this lead? Its history stays, and the person can be added again later.';

function RowButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
    >
      {children}
    </button>
  );
}

function RowActions({ row }: { row: LeadRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.paused ? (
        <form action={resumeLeadAction.bind(null, row.id)}>
          <RowButton>Resume</RowButton>
        </form>
      ) : (
        // A lead whose sequence is over has nothing left to pause.
        row.nextAction !== null && (
          <form action={pauseLeadAction.bind(null, row.id)}>
            <RowButton>Pause</RowButton>
          </form>
        )
      )}
      {row.status === 'failed' && (
        <form action={retryLeadAction.bind(null, row.id)}>
          <RowButton>Retry</RowButton>
        </form>
      )}
      <form
        action={removeLeadAction.bind(null, row.id)}
        onSubmit={(event) => {
          // A prevented submit never reaches the action.
          if (!window.confirm(REMOVE_CONFIRMATION)) event.preventDefault();
        }}
      >
        <RowButton>Remove</RowButton>
      </form>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  expanded,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
    >
      {children}
    </button>
  );
}

const TEXTAREA = 'w-full rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700';

/** Both drafts of one lead, editable while they can still be sent. Saving an edit approves it. */
function DraftEditor({
  row,
  founderNoteFromTemplate,
  onFeedback,
  onRegenerated,
}: {
  row: LeadRow;
  founderNoteFromTemplate: boolean;
  onFeedback: (feedback: Feedback | null) => void;
  onRegenerated: () => void;
}) {
  const savedNote = row.inviteNoteDraft ?? '';
  const savedMessage = row.firstMessageDraft ?? '';
  const [note, setNote] = useState(savedNote);
  const [message, setMessage] = useState(savedMessage);
  const [pending, setPending] = useState(false);
  const noteEditable = canEditInviteNote(row.status);
  const messageEditable = canEditFirstMessage(row.status);
  const noteNotice = noteNotSentNotice(row.status, founderNoteFromTemplate);
  const dirty = note !== savedNote || message !== savedMessage;

  async function act(work: () => Promise<Feedback | null>) {
    setPending(true);
    onFeedback(null);
    try {
      onFeedback(await work());
    } catch {
      onFeedback({ kind: 'error', lines: ['That did not work. Reload the page and try again.'] });
    } finally {
      setPending(false);
    }
  }

  const save = () =>
    act(async () => {
      const result = await saveDraftAction(row.id, { inviteNote: note, firstMessage: message });
      return result.ok ? { kind: 'info', lines: ['Saved and approved.'] } : { kind: 'error', lines: result.errors };
    });
  const approve = () =>
    act(async () => {
      // The note shown is the one approved: a draft rewritten since is not.
      const { ok } = await approveDraftAction(row.id, savedNote);
      return ok ? { kind: 'info', lines: ['Approved.'] } : { kind: 'error', lines: [CHANGED_SINCE_OPENED] };
    });
  const regenerate = () =>
    act(async () => {
      await regenerateDraftAction(row.id);
      onRegenerated();
      return { kind: 'info', lines: [REGENERATED] };
    });

  return (
    <div className="flex flex-col gap-2 py-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Invite note</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={!noteEditable || pending}
          rows={3}
          className={TEXTAREA}
        />
        <span className={`text-xs ${noteTooLong(note) ? 'text-red-600' : 'text-zinc-500'}`}>
          {noteLength(note)}/{INVITE_NOTE_MAX_LENGTH}
          {!noteEditable && ' · the invite was sent, so the note can no longer change'}
        </span>
        {noteNotice && <span className="text-xs text-zinc-500">{noteNotice}</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">First message</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={!messageEditable || pending}
          rows={8}
          className={TEXTAREA}
        />
        {!messageEditable && (
          <span className="text-xs text-zinc-500">The first message was sent, so it can no longer change.</span>
        )}
      </label>
      <div className="flex flex-wrap gap-1">
        <SmallButton onClick={save} disabled={pending || !dirty || !(noteEditable || messageEditable)}>
          Save
        </SmallButton>
        {row.draftStatus === 'ready' && (
          <SmallButton onClick={approve} disabled={pending || dirty}>
            Approve
          </SmallButton>
        )}
        {canRegenerate(row) && (
          <SmallButton onClick={regenerate} disabled={pending}>
            Regenerate
          </SmallButton>
        )}
      </div>
      {dirty && <Muted>Saving your edit approves it.</Muted>}
    </div>
  );
}

function DraftCell({
  row,
  founderNoteFromTemplate,
  open,
  onToggle,
  feedback,
  onFeedback,
}: {
  row: LeadRow;
  founderNoteFromTemplate: boolean;
  open: boolean;
  onToggle: () => void;
  feedback: Feedback | null;
  onFeedback: (feedback: Feedback | null) => void;
}) {
  const [pending, setPending] = useState(false);

  async function regenerateFailed() {
    setPending(true);
    onFeedback(null);
    try {
      await regenerateDraftAction(row.id);
      onFeedback({ kind: 'info', lines: [REGENERATED] });
    } catch {
      onFeedback({ kind: 'error', lines: ['That did not work. Reload the page and try again.'] });
    } finally {
      setPending(false);
    }
  }

  const preview = readyNotePreview(row, founderNoteFromTemplate);
  return (
    <div className="flex flex-col gap-1">
      <div>{row.draftStatus === 'none' ? '—' : row.draftStatus}</div>
      {row.draftStatus === 'failed' && row.draftError && <Muted>{row.draftError}</Muted>}
      {preview && <Muted>{preview}</Muted>}
      <div className="flex flex-wrap gap-1">
        {canReview(row) && (
          <SmallButton onClick={onToggle} expanded={open}>
            {open ? 'Close' : 'Review'}
          </SmallButton>
        )}
        {row.draftStatus === 'failed' && !open && canRegenerate(row) && (
          <SmallButton onClick={regenerateFailed} disabled={pending}>
            Regenerate
          </SmallButton>
        )}
      </div>
      {feedback &&
        feedback.lines.map((line) => (
          <div
            key={line}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={`text-xs ${feedback.kind === 'error' ? 'text-red-600' : 'text-zinc-500'}`}
          >
            {line}
          </div>
        ))}
    </div>
  );
}

const COLUMN_COUNT = 7;

function LeadRows({ row, founderNoteFromTemplate }: { row: LeadRow; founderNoteFromTemplate: boolean }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const reviewing = open && canReview(row);
  // A new draft, an approval or a saved edit gives the editor fresh texts.
  const draftKey = `${row.draftStatus}\u0000${row.inviteNoteDraft}\u0000${row.firstMessageDraft}`;

  return (
    <Fragment>
      <tr className={`align-top dark:border-zinc-800 ${reviewing ? '' : 'border-b border-zinc-200'}`}>
        <td className="py-2 pr-3">
          <div>{row.name}</div>
          {row.headline && <Muted>{row.headline}</Muted>}
          {row.role !== null && <Muted>{row.role}</Muted>}
        </td>
        <td className="py-2 pr-3">
          <a href={row.linkedinUrl} target="_blank" rel="noopener noreferrer" className="underline">
            Profile
          </a>
        </td>
        <td className="py-2 pr-3">
          <div>{row.status}</div>
          {row.failureReason && <Muted>{row.failureReason}</Muted>}
        </td>
        <td className="py-2 pr-3">
          <DraftCell
            row={row}
            founderNoteFromTemplate={founderNoteFromTemplate}
            open={reviewing}
            onToggle={() => setOpen((o) => !o)}
            feedback={feedback}
            onFeedback={setFeedback}
          />
        </td>
        <td className="py-2 pr-3">
          {row.lastAction ?? '—'}
          {row.lastActionAt && <Muted>{row.lastActionAt}</Muted>}
        </td>
        <td className="py-2 pr-3">
          {row.nextAction ?? '—'}
          {row.nextActionDueAt && <Muted>{row.nextActionDueAt}</Muted>}
        </td>
        <td className="py-2">
          <RowActions row={row} />
        </td>
      </tr>
      {reviewing && (
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <td colSpan={COLUMN_COUNT}>
            <DraftEditor
              key={draftKey}
              row={row}
              founderNoteFromTemplate={founderNoteFromTemplate}
              onFeedback={setFeedback}
              onRegenerated={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={active ? 'font-semibold underline' : 'underline-offset-2 hover:underline'}>
      {children}
    </Link>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-xs text-zinc-500">{children}</div>;
}

export function LeadTable({
  rows,
  statuses,
  activeStatus,
  founderNoteFromTemplate,
}: {
  rows: LeadRow[];
  statuses: string[];
  activeStatus: string | null;
  /** Settings sends the invite-note template to uploaded founders, so their note drafts are not sent. */
  founderNoteFromTemplate: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Leads</h2>
      <nav aria-label="Filter by status" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <FilterLink href="/" active={activeStatus === null}>
          All
        </FilterLink>
        {statuses.map((status) => (
          <FilterLink key={status} href={`/?status=${status}`} active={activeStatus === status}>
            {status}
          </FilterLink>
        ))}
      </nav>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-300 dark:border-zinc-700">
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">LinkedIn</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Draft</th>
              <th className="py-2 pr-3 font-medium">Last action</th>
              <th className="py-2 pr-3 font-medium">Next action</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className="py-3 text-zinc-500">
                  No leads.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <LeadRows key={row.id} row={row} founderNoteFromTemplate={founderNoteFromTemplate} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import type { LeadContext, LeadContextJob } from '@/db/schema';
import type { DraftPrompt } from '@/lib/openai/client';

/** The note the model aims for, with headroom under LinkedIn's 300-character limit that the code enforces. */
export const INVITE_NOTE_TARGET_LENGTH = 280;

// The writing rules. The owner's own words and the founder's data go in the user message only.
const DEVELOPER_MESSAGE = `You write two LinkedIn messages from the sender described under "About me" to the founder described below it. The goal of every conversation is a coffee at the founder's office. Everything about the sender comes from "About me" only.

1. inviteNote: the note sent with the connection request.
- At most ${INVITE_NOTE_TARGET_LENGTH} characters, spaces included. Count them.
- Address the founder by their first name.
- One concrete hook tied to this company, what it builds, or one of its open jobs. Not generic praise.
- Who the sender is, in a few words.
- Ask for a coffee.

2. firstMessage: sent after the founder is a connection.
- About 500 to 900 characters.
- The full pitch, taken from "About me".
- When the company has open coding jobs, name the most relevant one by its exact title and tie the pitch to it. When it has none, name no job.
- Ask for a coffee at their office, with the detail from "About me" that makes it easy (where the sender lives, when it says so).
- Never thank them for connecting and never mention the invite or the connection request: some founders get this message with no invite before it, so it must read true either way.

Both messages:
- Written in English.
- Use only facts from "About me" and from the founder and company sections. Invent nothing: no shared history, no mutual friends, no compliments on things you were not told, no numbers you were not given.
- The company section can hold a hiring pitch: what the company tells candidates about itself and the people it wants. Use it to choose the hook and what to say about the sender. Do not copy its sentences, and claim nothing about the sender that "About me" does not state.
- Plain, warm and direct. Not salesy: no buzzwords, no flattery, no marketing tone. Short sentences a person would type.
- No emoji, no hashtags, no links or URLs, no em dashes (use commas or periods instead).
- No {{, no brackets, no placeholders: every word is final text ready to send.

Answer with the JSON object only.`;

const line = (label: string, value: string | number | null | undefined) =>
  value === null || value === undefined || String(value).trim() === '' ? null : `${label}: ${String(value).trim()}`;

const lines = (...entries: Array<string | null>) => entries.filter((entry): entry is string => entry !== null).join('\n');

function jobSection(job: LeadContextJob, index: number): string {
  return lines(
    `### Job ${index + 1}: ${job.title}`,
    line('Category', job.category),
    line('Location', job.location),
    line('Remote', job.remote),
    line('Salary', job.salary),
    line('Equity', job.equity),
    line('Description', job.description),
  );
}

/** The developer message holds the rules; the user message holds the owner's text and the context, in labelled sections. */
export function buildDraftPrompt(aboutMe: string, context: LeadContext, opts: { previousNoteLength?: number } = {}): DraftPrompt {
  const { founder, company } = context;
  const firstName = founder.name.trim().split(/\s+/)[0] ?? founder.name;

  const sections = [
    `## About me (the sender)\n${aboutMe.trim()}`,
    `## Founder\n${lines(line('Name', founder.name), line('First name', firstName), line('Bio', founder.bio), line('Past companies', founder.pastCompanies))}`,
    `## Company\n${lines(
      line('Name', company.name),
      line('YC batch', company.batch),
      line('One-liner', company.oneLiner),
      line('Description', company.description),
      line('Team size', company.teamSize),
      line('Website', company.website),
      // Last: it can run to several paragraphs, and no other field of the company should follow them.
      line('Hiring pitch (what the company tells candidates)', company.hiringDescription),
    )}`,
    company.jobs.length === 0
      ? '## Open coding jobs\nThe company has no open coding job. Write about the company and name no job.'
      : `## Open coding jobs\n${company.jobs.map(jobSection).join('\n\n')}`,
  ];

  if (opts.previousNoteLength !== undefined) {
    sections.push(
      `## Length\nYour last invite note was ${opts.previousNoteLength} characters, over the limit. Write a new one that is under ${INVITE_NOTE_TARGET_LENGTH} characters.`,
    );
  }

  return { developer: DEVELOPER_MESSAGE, user: sections.join('\n\n') };
}

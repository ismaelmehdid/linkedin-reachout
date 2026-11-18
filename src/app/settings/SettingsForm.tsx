'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { ABOUT_ME_MAX_LENGTH, type Settings } from '@/lib/settings/settings';
import {
  INVITE_NOTE_MAX_LENGTH,
  renderTemplate,
  TEMPLATE_VARIABLES,
  type RenderResult,
  type TemplateValues,
} from '@/lib/templates/render';
import { saveSettingsAction, type SaveSettingsState } from './actions';

export type PreviewLead = { id: number; name: string; values: TemplateValues };

type Field<K> = { key: K; label: string };

const TEMPLATE_FIELDS: Field<keyof Settings['templates']>[] = [
  { key: 'inviteNote', label: 'Invite note' },
  { key: 'firstMessage', label: 'First message' },
  { key: 'followup1', label: 'Follow-up 1' },
  { key: 'followup2', label: 'Follow-up 2' },
];

const DELAY_FIELDS: Field<keyof Settings['delays']>[] = [
  { key: 'firstMessageMinMinutes', label: 'First message: at least this many minutes after acceptance' },
  { key: 'firstMessageMaxMinutes', label: 'First message: at most this many minutes after acceptance' },
  { key: 'followup1Days', label: 'Follow-up 1: days after the first message' },
  { key: 'followup2Days', label: 'Follow-up 2: days after follow-up 1' },
  { key: 'finishDays', label: 'End as no response: days after follow-up 2' },
  { key: 'inviteExpiryDays', label: 'Withdraw a pending invite after this many days' },
];

const CAP_FIELDS: (Field<keyof Settings['caps']> & { max?: number })[] = [
  { key: 'invitesPerDay', label: 'Invites per day' },
  { key: 'invitesPerWeek', label: 'Invites per rolling 7 days' },
  { key: 'messagesPerDay', label: 'Messages per day (first messages and follow-ups)' },
  { key: 'profileViewsPerDay', label: 'Profile views per day' },
  { key: 'jitterMaxSeconds', label: 'Random wait before each action: up to this many seconds (100 at most)', max: 100 },
];

const PACING_FIELDS: (Field<keyof Settings['pacing']> & { max: number; help: string })[] = [
  {
    key: 'minGapMinutes',
    label: 'Pause between sends: shortest average, in minutes (240 at most)',
    max: 240,
    help: "The day's sends are spread over the active hours, and the average pause is never shorter than this. 0 turns this lower bound off.",
  },
  {
    key: 'maxGapMinutes',
    label: 'Pause between sends: longest average, in minutes (240 at most)',
    max: 240,
    help: 'The average pause is never longer than this, and each pause is drawn between half and one and a half times the average. 0 turns the pauses off, also between invite withdrawals.',
  },
  {
    key: 'dayStartJitterMinutes',
    label: 'First send of the day: within this many minutes of the start (180 at most)',
    max: 180,
    help: 'The first send of the day waits for a random moment in this time after the active hours open. 0 turns this off.',
  },
  {
    key: 'followupJitterMinutes',
    label: 'Follow-up time: up to this many extra minutes (720 at most)',
    max: 720,
    help: 'A follow-up is due after its delay in days plus a random part of this time, so it does not come at the same hour as the message before. 0 turns this off.',
  },
];

/** Index + 1 is the ISO weekday the form sends. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const INITIAL_STATE: SaveSettingsState = { ok: false, errors: [] };

const KNOWN_VARIABLES: readonly string[] = TEMPLATE_VARIABLES;

const INPUT_CLASS = 'rounded border border-zinc-300 px-3 py-2';

function previewProblems(result: Exclude<RenderResult, { ok: true }>): string[] {
  if (result.reason === 'invalid_syntax') return ['Has an unclosed or malformed {{ }} tag'];
  const unknown = result.missing.filter((name) => !KNOWN_VARIABLES.includes(name));
  const missing = result.missing.filter((name) => KNOWN_VARIABLES.includes(name));
  return [
    ...unknown.map((name) => `Unknown variable {{${name}}}`),
    ...(missing.length > 0 ? [`Missing: ${missing.join(', ')}`] : []),
  ];
}

function TemplatePreview({ result }: { result: RenderResult }) {
  if (result.ok) {
    return <p className="whitespace-pre-wrap rounded bg-zinc-500/10 px-3 py-2 text-sm">{result.text}</p>;
  }
  return (
    <ul className="rounded bg-zinc-500/10 px-3 py-2 text-sm text-red-600">
      {previewProblems(result).map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

function NumberField({ name, label, value, max, help }: { name: string; label: string; value: number; max?: number; help?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={value}
        min={0}
        max={max}
        step={1}
        required
        className={INPUT_CLASS}
      />
      {help && <span className="text-sm text-zinc-500">{help}</span>}
    </label>
  );
}

export default function SettingsForm({ settings, leads }: { settings: Settings; leads: PreviewLead[] }) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, INITIAL_STATE);
  const [templates, setTemplates] = useState(settings.templates);
  const [previewLeadId, setPreviewLeadId] = useState(leads[0]?.id);
  const previewLead = leads.find((lead) => lead.id === previewLeadId) ?? leads[0];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // Dispatching the action here, instead of letting React run `action`, skips React's automatic form reset.
    // A reset would put the saved values back and drop the user's edits when the save fails. `action` still
    // serves a submit made before hydration.
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">About me</h2>
        <p className="text-sm text-zinc-500">
          Your pitch, in your own words. The AI writes each uploaded founder&apos;s invite note and first message from
          it, and uses no other fact about you.
        </p>
        <textarea
          name="aboutMe"
          aria-label="About me"
          defaultValue={settings.aboutMe}
          rows={6}
          maxLength={ABOUT_ME_MAX_LENGTH}
          className={INPUT_CLASS}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Templates</h2>
        <p className="text-sm text-zinc-500">
          Variables: {TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(', ')}. Names are case-sensitive. Add a
          fallback with {'{{company|your team}}'}; without one, a lead with no value for a variable fails before
          anything is sent.
        </p>

        {previewLead ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm">Preview with</span>
            <select
              value={previewLead.id}
              onChange={(event) => setPreviewLeadId(Number(event.target.value))}
              className={INPUT_CLASS}
            >
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm text-zinc-500">No lead with a fetched profile yet, so there is nothing to preview.</p>
        )}

        {TEMPLATE_FIELDS.map(({ key, label }) => {
          const template = templates[key];
          const result = previewLead ? renderTemplate(template, previewLead.values) : null;
          const noteLength = result?.ok ? result.text.length : template.length;
          return (
            <div key={key} className="flex flex-col gap-1">
              <label htmlFor={key} className="text-sm font-medium">
                {label}
              </label>
              <textarea
                id={key}
                name={key}
                value={template}
                onChange={(event) => {
                  const { value } = event.target;
                  setTemplates((current) => ({ ...current, [key]: value }));
                }}
                rows={4}
                className={INPUT_CLASS}
              />
              {key === 'inviteNote' && (
                <p className={`text-sm ${noteLength > INVITE_NOTE_MAX_LENGTH ? 'text-red-600' : 'text-zinc-500'}`}>
                  {noteLength}/{INVITE_NOTE_MAX_LENGTH}
                </p>
              )}
              {result && <TemplatePreview result={result} />}
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Delays</h2>
        {DELAY_FIELDS.map(({ key, label }) => (
          <NumberField key={key} name={key} label={label} value={settings.delays[key]} />
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Limits</h2>
        {CAP_FIELDS.map(({ key, label, max }) => (
          <NumberField key={key} name={key} label={label} value={settings.caps[key]} max={max} />
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Spacing</h2>
        {PACING_FIELDS.map(({ key, label, max, help }) => (
          <NumberField key={key} name={key} label={label} value={settings.pacing[key]} max={max} help={help} />
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Active hours</h2>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">Days</legend>
          <div className="flex flex-wrap gap-4">
            {WEEKDAYS.map((day, index) => (
              <label key={day} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="windowDays"
                  value={String(index + 1)}
                  defaultChecked={settings.window.days.includes(index + 1)}
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Start</span>
          <input type="time" name="windowStart" defaultValue={settings.window.start} required className={INPUT_CLASS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">End</span>
          <input type="time" name="windowEnd" defaultValue={settings.window.end} required className={INPUT_CLASS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Timezone (for example America/Los_Angeles)</span>
          <input type="text" name="timezone" defaultValue={settings.window.timezone} required className={INPUT_CLASS} />
        </label>
      </section>

      <div className="flex flex-col gap-3">
        {state.errors.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-sm text-red-600">
            {state.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-green-700">
            Settings saved.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </form>
  );
}

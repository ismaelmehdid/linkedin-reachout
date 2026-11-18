import { z } from 'zod';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** Under the dashboard page's 120 s `maxDuration`, so a slow answer fails the lead instead of the request. */
export const OPENAI_TIMEOUT_MS = 100_000;

/** Reasoning tokens count toward this limit, so it is far above what two short texts need. */
const MAX_OUTPUT_TOKENS = 16_000;

export type DraftPrompt = { developer: string; user: string };

export type DraftTexts = { inviteNote: string; firstMessage: string };

/** `timeoutMs` overrides the writer's own timeout for this call, so a caller can keep several calls under one deadline. */
export type DraftWriteOptions = { timeoutMs?: number };

export type DraftWriter = { write(prompt: DraftPrompt, options?: DraftWriteOptions): Promise<DraftTexts> };

/**
 * `code` is short and stored on the lead as its draft error: `rate_limited`, `timeout`, `network_error`,
 * `refused`, `invalid_output` or `openai_error: <status>`. Neither it nor the message ever holds the key
 * or the response body.
 */
export class DraftWriterError extends Error {
  constructor(
    public code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'DraftWriterError';
  }
}

const DRAFTS_SCHEMA = {
  type: 'object',
  properties: { inviteNote: { type: 'string' }, firstMessage: { type: 'string' } },
  required: ['inviteNote', 'firstMessage'],
  additionalProperties: false,
} as const;

const responseSchema = z.looseObject({
  status: z.string().nullish(),
  incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
  output: z
    .array(
      z.looseObject({
        type: z.string(),
        content: z.array(z.looseObject({ type: z.string(), text: z.unknown().optional() })).nullish(),
      }),
    )
    .nullish(),
});

const draftsSchema = z.object({ inviteNote: z.string(), firstMessage: z.string() });

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** The drafts in a Responses API answer. Over raw HTTP the text sits in `output[].content[]`, not in `output_text`. */
function readDrafts(data: unknown): DraftTexts {
  const parsed = responseSchema.safeParse(data);
  if (!parsed.success) throw new DraftWriterError('invalid_output', 'Unexpected OpenAI response shape');
  const response = parsed.data;
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new DraftWriterError('invalid_output', `OpenAI response incomplete: ${reason}`);
  }

  const parts = (response.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  if (parts.some((part) => part.type === 'refusal')) throw new DraftWriterError('refused', 'OpenAI refused to write the drafts');

  const text = parts
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  if (text === '') throw new DraftWriterError('invalid_output', 'OpenAI response holds no output text');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DraftWriterError('invalid_output', 'OpenAI output is not JSON');
  }
  const drafts = draftsSchema.safeParse(json);
  if (!drafts.success) throw new DraftWriterError('invalid_output', 'OpenAI output does not match the drafts schema');
  return drafts.data;
}

/** A small `fetch` wrapper around the Responses API, with no SDK. `fetch` is injected in tests. */
export function createDraftWriter(opts: { apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }): DraftWriter {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? OPENAI_TIMEOUT_MS;

  return {
    async write(prompt, options) {
      const body = {
        model: opts.model,
        input: [
          { role: 'developer', content: prompt.developer },
          { role: 'user', content: prompt.user },
        ],
        // No `temperature`: the model's predecessor refused a custom one.
        reasoning: { effort: 'high' },
        text: { format: { type: 'json_schema', name: 'drafts', strict: true, schema: DRAFTS_SCHEMA } },
        max_output_tokens: MAX_OUTPUT_TOKENS,
      };

      let res: Response;
      try {
        res = await fetchImpl(RESPONSES_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options?.timeoutMs ?? timeoutMs),
        });
      } catch (err) {
        if (isTimeout(err)) throw new DraftWriterError('timeout', 'OpenAI did not answer in time');
        throw new DraftWriterError('network_error', 'OpenAI could not be reached');
      }

      if (res.status === 429) throw new DraftWriterError('rate_limited', 'OpenAI answered 429');
      if (!res.ok) throw new DraftWriterError(`openai_error: ${res.status}`, `OpenAI answered ${res.status}`);

      let data: unknown;
      try {
        data = await res.json();
      } catch (err) {
        // The timeout also covers reading the body.
        if (isTimeout(err)) throw new DraftWriterError('timeout', 'OpenAI did not answer in time');
        throw new DraftWriterError('invalid_output', 'OpenAI response is not JSON');
      }
      return readDrafts(data);
    },
  };
}

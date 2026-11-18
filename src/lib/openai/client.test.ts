import { beforeEach, describe, expect, it } from 'vitest';
import { createDraftWriter, DraftWriterError, OPENAI_TIMEOUT_MS, type DraftWriter } from './client';

const API_KEY = 'sk-test-secret-key';
const PROMPT = { developer: 'Rules here', user: 'Context here' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Responses API answer whose message holds `text` as its output text. */
const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
  ],
  ...extra,
});

const drafts = { inviteNote: 'Hi Jane', firstMessage: 'Hi Jane, longer.' };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DraftWriterError);
    const error = err as DraftWriterError;
    expect(error.message).not.toContain(API_KEY);
    return error.code;
  }
  throw new Error('expected the write to fail');
}

describe('createDraftWriter', () => {
  let captured: Array<{ request: Request; signal: AbortSignal | null | undefined }>;
  let respond: () => Promise<Response>;
  let writer: DraftWriter;

  beforeEach(() => {
    captured = [];
    respond = async () => json(200, answer(JSON.stringify(drafts)));
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ request: new Request(input, init), signal: init?.signal });
      return respond();
    };
    writer = createDraftWriter({ apiKey: API_KEY, model: 'gpt-6.2-astra', fetch: fetchStub as typeof fetch });
  });

  it('posts the prompt to the Responses API with a strict JSON schema and returns both drafts', async () => {
    expect(await writer.write(PROMPT)).toEqual(drafts);
    const { request, signal } = captured[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(OPENAI_TIMEOUT_MS).toBe(100_000);

    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-6.2-astra',
      input: [
        { role: 'developer', content: 'Rules here' },
        { role: 'user', content: 'Context here' },
      ],
      reasoning: { effort: 'high' },
      text: {
        format: {
          type: 'json_schema',
          name: 'drafts',
          strict: true,
          schema: {
            type: 'object',
            properties: { inviteNote: { type: 'string' }, firstMessage: { type: 'string' } },
            required: ['inviteNote', 'firstMessage'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(typeof body.max_output_tokens).toBe('number');
    expect(body).not.toHaveProperty('temperature');
  });

  it('times out after the per-call timeout when one is given', async () => {
    let signal: AbortSignal | null | undefined;
    const slow = createDraftWriter({
      apiKey: API_KEY,
      model: 'm',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        await new Promise((resolve) => setTimeout(resolve, 200));
        signal?.throwIfAborted();
        return json(200, answer(JSON.stringify(drafts)));
      }) as typeof fetch,
    });
    expect(await codeOf(slow.write(PROMPT, { timeoutMs: 20 }))).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('reads the output text across several content parts', async () => {
    const text = JSON.stringify(drafts);
    respond = async () =>
      json(200, {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: text.slice(0, 10) },
              { type: 'output_text', text: text.slice(10) },
            ],
          },
        ],
      });
    expect(await writer.write(PROMPT)).toEqual(drafts);
  });

  it('maps 429 to rate_limited and any other error status to openai_error with the status', async () => {
    respond = async () => json(429, { error: { message: `quota for ${API_KEY}` } });
    expect(await codeOf(writer.write(PROMPT))).toBe('rate_limited');
    respond = async () => json(500, { error: { message: 'boom' } });
    expect(await codeOf(writer.write(PROMPT))).toBe('openai_error: 500');
    respond = async () => new Response('not json', { status: 401 });
    expect(await codeOf(writer.write(PROMPT))).toBe('openai_error: 401');
  });

  it('maps a timeout to timeout and another network failure to network_error', async () => {
    respond = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    expect(await codeOf(writer.write(PROMPT))).toBe('timeout');
    respond = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await codeOf(writer.write(PROMPT))).toBe('network_error');
  });

  it('maps a refusal to refused', async () => {
    respond = async () =>
      json(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] });
    expect(await codeOf(writer.write(PROMPT))).toBe('refused');
  });

  it('maps an incomplete answer, bad JSON, a wrong shape or no text to invalid_output', async () => {
    const cases: unknown[] = [
      answer(JSON.stringify(drafts), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
      answer('{"inviteNote": "Hi'),
      answer(JSON.stringify({ inviteNote: 'Hi' })),
      answer(JSON.stringify({ inviteNote: 1, firstMessage: 'x' })),
      { status: 'completed', output: [{ type: 'reasoning' }] },
      { status: 'completed' },
      'just a string',
    ];
    for (const body of cases) {
      respond = async () => json(200, body);
      expect(await codeOf(writer.write(PROMPT))).toBe('invalid_output');
    }
    respond = async () => new Response('<html>', { status: 200 });
    expect(await codeOf(writer.write(PROMPT))).toBe('invalid_output');
  });

  it('never puts the response body in the error message', async () => {
    respond = async () => json(200, answer('secret body text that is not json'));
    try {
      await writer.write(PROMPT);
    } catch (err) {
      expect((err as Error).message).not.toContain('secret body text');
      return;
    }
    throw new Error('expected the write to fail');
  });
});

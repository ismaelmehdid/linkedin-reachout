import { z } from 'zod';
import { UnipileError } from './errors';
import type { ChatMessage, NetworkDistance, SentInvitation, UnipileClient, UnipileProfile } from './types';

const NETWORK_DISTANCES: readonly string[] = ['FIRST_DEGREE', 'SECOND_DEGREE', 'THIRD_DEGREE', 'OUT_OF_NETWORK'];
const MAX_INVITATION_PAGES = 20;

const str = z.string().nullish();

const profileSchema = z.looseObject({
  provider_id: z.string().min(1),
  public_identifier: str,
  first_name: str,
  last_name: str,
  headline: str,
  location: str,
  network_distance: z.string().nullish(),
  work_experience: z
    .array(
      z.looseObject({
        company: str,
        position: str,
        current: z.boolean().nullish(),
        end: z.unknown().optional(),
      }),
    )
    .nullish(),
});

const invitationPageSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        invited_user_id: str,
        invited_user_public_id: str,
      }),
    )
    .nullish(),
  cursor: z.string().nullish(),
});

const messagePageSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        is_sender: z.union([z.boolean(), z.number()]).nullish(),
        timestamp: z.string(),
        text: str,
      }),
    )
    .nullish(),
});

const invitationResultSchema = z.looseObject({ invitation_id: z.string() });
const chatResultSchema = z.looseObject({ chat_id: z.string(), message_id: z.string() });
const messageResultSchema = z.looseObject({ message_id: z.string() });

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new UnipileError(422, 'errors/invalid_response', `Unexpected Unipile response: ${result.error.message}`);
  }
  return result.data;
}

function mapProfile(raw: z.infer<typeof profileSchema>): UnipileProfile {
  const experience = raw.work_experience ?? [];
  const current =
    experience.find((e) => e.current === true) ??
    experience.find((e) => e.end === undefined || e.end === null || e.end === '');
  const distance = raw.network_distance ?? null;
  return {
    providerId: raw.provider_id,
    publicIdentifier: raw.public_identifier ?? null,
    firstName: raw.first_name ?? null,
    lastName: raw.last_name ?? null,
    headline: raw.headline ?? null,
    location: raw.location ?? null,
    networkDistance:
      distance !== null && NETWORK_DISTANCES.includes(distance) ? (distance as NetworkDistance) : null,
    currentCompany: current?.company ?? null,
    currentPosition: current?.position ?? null,
  };
}

export function createUnipileClient(opts: {
  dsn: string;
  apiKey: string;
  accountId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): UnipileClient {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.dsn) ? opts.dsn : `https://${opts.dsn}`;
  const baseUrl = withScheme.replace(/\/+$/, '');
  const accountParam = `account_id=${encodeURIComponent(opts.accountId)}`;

  async function request(method: string, path: string, body?: BodyInit, json = false): Promise<unknown> {
    const headers: Record<string, string> = { 'X-API-KEY': opts.apiKey, accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UnipileError(0, 'network_error', err instanceof Error ? err.message : String(err));
    }

    if (!res.ok) throw await toError(res);
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  async function toError(res: Response): Promise<UnipileError> {
    let body: { type?: unknown; detail?: unknown; title?: unknown; retry_after?: unknown } = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') body = parsed as typeof body;
    } catch {
      // Body is not JSON: keep type null.
    }
    const headerValue = Number(res.headers.get('retry-after'));
    const retryAfter =
      typeof body.retry_after === 'number'
        ? body.retry_after
        : res.headers.get('retry-after') !== null && Number.isFinite(headerValue)
          ? headerValue
          : null;
    const message = [body.detail, body.title].find((v): v is string => typeof v === 'string' && v !== '');
    return new UnipileError(
      res.status,
      typeof body.type === 'string' ? body.type : null,
      message ?? res.statusText,
      retryAfter,
    );
  }

  function multipart(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return form;
  }

  return {
    async getProfile(identifier) {
      const data = await request(
        'GET',
        `/api/v1/users/${encodeURIComponent(identifier)}?${accountParam}&linkedin_sections=experience_preview`,
      );
      return mapProfile(parseOrThrow(profileSchema, data));
    },

    async sendInvitation(providerId, message) {
      const data = await request(
        'POST',
        '/api/v1/users/invite',
        JSON.stringify({ provider_id: providerId, account_id: opts.accountId, message }),
        true,
      );
      return { invitationId: parseOrThrow(invitationResultSchema, data).invitation_id };
    },

    async listSentInvitations() {
      const result: SentInvitation[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_INVITATION_PAGES; page++) {
        const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const data = await request('GET', `/api/v1/users/invite/sent?${accountParam}&limit=100${suffix}`);
        const parsed = parseOrThrow(invitationPageSchema, data);
        for (const item of parsed.items ?? []) {
          result.push({
            id: item.id,
            invitedUserId: item.invited_user_id ?? null,
            invitedUserPublicId: item.invited_user_public_id ?? null,
          });
        }
        cursor = parsed.cursor ?? null;
        if (!cursor) break;
      }
      return result;
    },

    async cancelInvitation(invitationId) {
      await request('DELETE', `/api/v1/users/invite/sent/${encodeURIComponent(invitationId)}?${accountParam}`);
    },

    async startChat(providerId, text) {
      const data = await request(
        'POST',
        '/api/v1/chats',
        multipart({ account_id: opts.accountId, attendees_ids: providerId, text }),
      );
      const parsed = parseOrThrow(chatResultSchema, data);
      return { chatId: parsed.chat_id, messageId: parsed.message_id };
    },

    async sendMessage(chatId, text) {
      const data = await request(
        'POST',
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
        multipart({ text }),
      );
      return { messageId: parseOrThrow(messageResultSchema, data).message_id };
    },

    async listChatMessages(chatId, limit) {
      const data = await request(
        'GET',
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${encodeURIComponent(String(limit))}`,
      );
      const parsed = parseOrThrow(messagePageSchema, data);
      return (parsed.items ?? []).map(
        (m): ChatMessage => ({
          id: m.id,
          isSender: m.is_sender === true || m.is_sender === 1,
          timestamp: m.timestamp,
          text: m.text ?? null,
        }),
      );
    },
  };
}

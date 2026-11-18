import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { stubTestEnv, TEST_ENV } from '@/test-utils/env';
import { login } from './actions';

/**
 * Stand-ins for the two Next.js request APIs the action calls, which only work inside a request: a cookie
 * store that records what is set, and a redirect that throws, as the real one does.
 */
const { cookieJar, Redirected } = vi.hoisted(() => {
  class Redirected extends Error {
    readonly path: string;
    constructor(path: string) {
      super(`redirect to ${path}`);
      this.path = path;
    }
  }
  return { cookieJar: new Map<string, string>(), Redirected };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Redirected(path);
  },
}));

const form = (password: string): FormData => {
  const data = new FormData();
  data.set('password', password);
  return data;
};

/** Runs a fresh copy of the action while `DRY_RUN` is missing, as on a deployment that lacks a variable. */
async function loginWhileMisconfigured(password: string) {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('DRY_RUN', '');
  try {
    vi.resetModules();
    const fresh = await import('./actions');
    return { answer: await fresh.login({}, form(password)), errors };
  } finally {
    stubTestEnv();
  }
}

describe('login', () => {
  beforeAll(stubTestEnv);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    cookieJar.clear();
  });

  it('opens a session and goes to the dashboard for the right password', async () => {
    const outcome = await login({}, form(TEST_ENV.APP_PASSWORD)).catch((thrown: unknown) => thrown);

    expect(outcome).toBeInstanceOf(Redirected);
    expect((outcome as InstanceType<typeof Redirected>).path).toBe('/');
    expect(await verifySessionToken(cookieJar.get(SESSION_COOKIE), TEST_ENV.APP_PASSWORD, new Date())).toBe(true);
  });

  it('answers Wrong password to a wrong password, and opens no session', async () => {
    vi.useFakeTimers();

    const answer = login({}, form(`${TEST_ENV.APP_PASSWORD}x`));
    await vi.runAllTimersAsync();

    expect(await answer).toEqual({ error: 'Wrong password' });
    expect(cookieJar.size).toBe(0);
  });

  it('keeps a wrong password waiting 1 s for its answer', async () => {
    vi.useFakeTimers();
    let answered = false;
    const answer = login({}, form(`${TEST_ENV.APP_PASSWORD}x`)).finally(() => {
      answered = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(answered).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
    await answer;
  });

  describe('while an environment variable is missing', () => {
    it('answers with a message that points to the log, instead of failing', async () => {
      const { answer } = await loginWhileMisconfigured(TEST_ENV.APP_PASSWORD);

      expect(answer.error).toMatch(/function log/i);
      expect(answer.error).not.toBe('Wrong password');
    });

    it('opens no session, even for the right password', async () => {
      await loginWhileMisconfigured(TEST_ENV.APP_PASSWORD);

      expect(cookieJar.size).toBe(0);
    });

    it('names the variable in the server log, never in the answer', async () => {
      const { answer, errors } = await loginWhileMisconfigured(TEST_ENV.APP_PASSWORD);

      expect(errors).toHaveBeenCalledWith(expect.any(String), 'Missing environment variables: DRY_RUN');
      expect(answer.error).not.toContain('DRY_RUN');
    });
  });
});

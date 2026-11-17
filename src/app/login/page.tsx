'use client';

import { useActionState } from 'react';
import { login, type LoginState } from './actions';

const INITIAL_STATE: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={formAction} className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          name="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          required
          autoFocus
          className="rounded border border-zinc-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          Log in
        </button>
        {state.error && (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        )}
      </form>
    </main>
  );
}

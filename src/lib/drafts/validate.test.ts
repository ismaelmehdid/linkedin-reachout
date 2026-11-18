import { describe, expect, it } from 'vitest';
import { checkDraftTexts, FIRST_MESSAGE_MAX_LENGTH } from './validate';

const good = { inviteNote: 'Hi Jane, coffee soon?', firstMessage: 'Hi Jane, here is who I am.' };

describe('checkDraftTexts', () => {
  it('accepts two plain texts, a note of exactly 300 characters included', () => {
    expect(checkDraftTexts(good)).toEqual([]);
    expect(checkDraftTexts({ ...good, inviteNote: 'a'.repeat(300) })).toEqual([]);
  });

  it('refuses empty texts, whitespace only included', () => {
    const errors = checkDraftTexts({ inviteNote: '  \n', firstMessage: '' });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^Invite note: .*empty/);
    expect(errors[1]).toMatch(/^First message: .*empty/);
  });

  it('refuses a note over 300 characters and says its length', () => {
    const errors = checkDraftTexts({ ...good, inviteNote: 'a'.repeat(301) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Invite note: .*300.*301/);
  });

  it('refuses a first message over 8000 characters', () => {
    expect(FIRST_MESSAGE_MAX_LENGTH).toBe(8000);
    expect(checkDraftTexts({ ...good, firstMessage: 'a'.repeat(8000) })).toEqual([]);
    expect(checkDraftTexts({ ...good, firstMessage: 'a'.repeat(8001) })[0]).toMatch(/^First message: .*8000/);
  });

  it('refuses a text holding {{ in either draft', () => {
    expect(checkDraftTexts({ ...good, inviteNote: 'Hi {{first_name}}' })[0]).toMatch(/^Invite note: .*\{\{/);
    expect(checkDraftTexts({ ...good, firstMessage: 'Hi {{ there' })[0]).toMatch(/^First message: .*\{\{/);
  });
});

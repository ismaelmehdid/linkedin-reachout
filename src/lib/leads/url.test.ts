import { describe, expect, it } from 'vitest';
import { parseLinkedInProfileUrl } from './url';

describe('parseLinkedInProfileUrl', () => {
  it.each([
    ['https://www.linkedin.com/in/jane-doe', 'jane-doe'],
    ['linkedin.com/in/jane-doe/', 'jane-doe'],
    ['https://fr.linkedin.com/in/jane-doe?utm_source=x#top', 'jane-doe'],
    ['  www.linkedin.com/in/ACoAABcdEf  ', 'ACoAABcdEf'],
    ['https://www.linkedin.com/in/j%C3%A9r%C3%B4me', 'jérôme'],
  ])('accepts %s', (input, slug) =>
    expect(parseLinkedInProfileUrl(input)).toMatchObject({ ok: true, slug }),
  );

  it('builds a canonical URL', () =>
    expect(parseLinkedInProfileUrl('linkedin.com/in/jane-doe/')).toEqual({
      ok: true,
      slug: 'jane-doe',
      url: 'https://www.linkedin.com/in/jane-doe',
    }));

  it.each([
    ['https://www.linkedin.com/company/acme', 'not a profile URL (expected linkedin.com/in/...)'],
    [
      'https://www.linkedin.com/sales/lead/ACwAA,NAME_SEARCH',
      'not a profile URL (expected linkedin.com/in/...)',
    ],
    [
      'https://www.linkedin.com/in/jane-doe/details/experience',
      'not a profile URL (expected linkedin.com/in/...)',
    ],
    ['https://evil-linkedin.com/in/jane', 'not a LinkedIn URL'],
    ['hello', 'not a LinkedIn URL'],
  ])('rejects %s', (input, error) =>
    expect(parseLinkedInProfileUrl(input)).toEqual({ ok: false, error }),
  );

  it.each(['https://www.linkedin.com/in/jane-doe/en', 'linkedin.com/in/jane-doe/fr/'])(
    'ignores a two-letter language suffix in %s',
    (input) =>
      expect(parseLinkedInProfileUrl(input)).toEqual({
        ok: true,
        slug: 'jane-doe',
        url: 'https://www.linkedin.com/in/jane-doe',
      }),
  );

  it.each([
    'https://www.linkedin.com/in/jane-doe/eng',
    'https://www.linkedin.com/in/jane-doe/en/extra',
  ])('rejects extra path segments in %s', (input) =>
    expect(parseLinkedInProfileUrl(input)).toEqual({
      ok: false,
      error: 'not a profile URL (expected linkedin.com/in/...)',
    }),
  );
});

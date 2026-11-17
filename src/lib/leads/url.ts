export type ParsedLinkedInUrl =
  | { ok: true; slug: string; url: string }
  | { ok: false; error: string };

const NOT_LINKEDIN = 'not a LinkedIn URL';
const NOT_PROFILE = 'not a profile URL (expected linkedin.com/in/...)';

// linkedin.com, www.linkedin.com, or a two-letter country subdomain such as fr.linkedin.com.
const LINKEDIN_HOST = /^(?:www\.|[a-z]{2}\.)?linkedin\.com$/;

export function parseLinkedInProfileUrl(input: string): ParsedLinkedInUrl {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: NOT_LINKEDIN };
  }
  if (!LINKEDIN_HOST.test(parsed.hostname)) return { ok: false, error: NOT_LINKEDIN };

  const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match) return { ok: false, error: NOT_PROFILE };

  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return { ok: false, error: NOT_PROFILE };
  }
  return { ok: true, slug, url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}` };
}

// Pure module: no Node, database or project imports. It is also used from client components.

export const TEMPLATE_VARIABLES = ['first_name', 'last_name', 'headline', 'company', 'position', 'location'] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type TemplateValues = Partial<Record<TemplateVariable, string | null>>;

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing_variable'; missing: string[] }
  | { ok: false; reason: 'invalid_syntax' };

export type TemplateIssue =
  | { kind: 'empty' }
  | { kind: 'unknown_variable'; name: string }
  | { kind: 'single_brace'; name: string }
  | { kind: 'unclosed_tag' };

export const INVITE_NOTE_MAX_LENGTH = 300;

// A tag: `{{`, optional spaces, a name, optional spaces, an optional `|fallback`, then `}}`.
// The name is any run of characters other than whitespace, `|`, `{` and `}` (case-sensitive);
// the fallback is any characters except `{` and `}`.
const TAG_PATTERN = /\{\{\s*([^\s|{}]+)\s*(?:\|([^{}]*))?\}\}/g;

// The same shape in single braces, such as `{first_name}` or `{ company|your team }`.
const SINGLE_BRACE_PATTERN = /\{\s*([^\s|{}]+)\s*(?:\|[^{}]*)?\}/g;

const KNOWN_VARIABLES: ReadonlySet<string> = new Set(TEMPLATE_VARIABLES);

function hasUnclosedTag(template: string): boolean {
  return template.replace(TAG_PATTERN, '').includes('{{');
}

/** The known variables written in single braces. Such a tag is not replaced: it would be sent as written. */
function singleBraceVariables(template: string): string[] {
  const rest = template.replace(TAG_PATTERN, '');
  const names: string[] = [];
  for (const match of rest.matchAll(SINGLE_BRACE_PATTERN)) {
    // After a `{` it is a double-brace tag that lost a closing brace, which is reported as unclosed.
    if (match.index > 0 && rest[match.index - 1] === '{') continue;
    const name = match[1];
    if (KNOWN_VARIABLES.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export function renderTemplate(template: string, values: TemplateValues): RenderResult {
  if (hasUnclosedTag(template)) return { ok: false, reason: 'invalid_syntax' };

  const missing: string[] = [];
  const text = template.replace(TAG_PATTERN, (_tag, name: string, fallback: string | undefined) => {
    const value = KNOWN_VARIABLES.has(name) ? values[name as TemplateVariable]?.trim() : undefined;
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    if (!missing.includes(name)) missing.push(name);
    return '';
  });

  if (missing.length > 0) return { ok: false, reason: 'missing_variable', missing };
  // A lead's own value may contain `{{`; never let it through.
  if (text.includes('{{')) return { ok: false, reason: 'invalid_syntax' };
  return { ok: true, text };
}

export function validateTemplate(template: string): TemplateIssue[] {
  if (template.trim() === '') return [{ kind: 'empty' }];

  const issues: TemplateIssue[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(TAG_PATTERN)) {
    const name = match[1];
    if (!KNOWN_VARIABLES.has(name) && !seen.has(name)) {
      seen.add(name);
      issues.push({ kind: 'unknown_variable', name });
    }
  }
  for (const name of singleBraceVariables(template)) issues.push({ kind: 'single_brace', name });
  if (hasUnclosedTag(template)) issues.push({ kind: 'unclosed_tag' });
  return issues;
}

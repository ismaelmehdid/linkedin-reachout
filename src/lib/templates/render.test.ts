import { describe, it, expect } from 'vitest';
import { renderTemplate, validateTemplate } from './render';

const values = { first_name: 'Jane', company: 'Acme', location: '  ' };

describe('renderTemplate', () => {
  it('replaces variables, with or without spaces in the tag', () =>
    expect(renderTemplate('Hi {{first_name}} at {{ company }}', values)).toEqual({ ok: true, text: 'Hi Jane at Acme' }));
  it('uses the fallback when the value is missing or blank', () =>
    expect(renderTemplate('{{location|your city}} / {{headline| there }}', values)).toEqual({ ok: true, text: 'your city / there' }));
  it('allows an empty fallback', () => expect(renderTemplate('Hi{{last_name|}}!', values)).toEqual({ ok: true, text: 'Hi!' }));
  it('reports every missing variable once, in order', () =>
    expect(renderTemplate('{{last_name}} {{position}} {{first_name}} {{last_name}}', values))
      .toEqual({ ok: false, reason: 'missing_variable', missing: ['last_name', 'position'] }));
  it('treats an unknown variable as missing', () =>
    expect(renderTemplate('{{firstname}}', values)).toEqual({ ok: false, reason: 'missing_variable', missing: ['firstname'] }));
  it('refuses a template with an unclosed tag', () =>
    expect(renderTemplate('Hi {{first_name', values)).toEqual({ ok: false, reason: 'invalid_syntax' }));
  it('refuses a fallback that contains a tag', () =>
    expect(renderTemplate('Hi {{company|{{position}}}}', { position: 'CTO' })).toEqual({ ok: false, reason: 'invalid_syntax' }));
  it('refuses output that still contains {{ from a value', () =>
    expect(renderTemplate('About {{headline}}', { headline: 'I build {{mustache}} engines' })).toEqual({ ok: false, reason: 'invalid_syntax' }));
  it('treats a name with the wrong case as missing', () =>
    expect(renderTemplate('{{First_Name}}', { first_name: 'Jane' })).toEqual({ ok: false, reason: 'missing_variable', missing: ['First_Name'] }));
  it('trims inserted values', () =>
    expect(renderTemplate('Hi {{first_name}}', { first_name: '  Jane ' })).toEqual({ ok: true, text: 'Hi Jane' }));
});

describe('validateTemplate', () => {
  it('accepts a valid template', () => expect(validateTemplate('Hi {{first_name|there}}')).toEqual([]));
  it('flags empty templates', () => expect(validateTemplate('  \n ')).toEqual([{ kind: 'empty' }]));
  it('flags unknown variables', () =>
    expect(validateTemplate('{{firstname}} {{company}}')).toEqual([{ kind: 'unknown_variable', name: 'firstname' }]));
  it('flags a fallback that contains a tag as an unclosed tag', () =>
    expect(validateTemplate('Hi {{company|{{position}}}}')).toEqual([{ kind: 'unclosed_tag' }]));
  it('flags closed tags with a wrong-case or hyphenated name as unknown variables', () =>
    expect(validateTemplate('Hi {{First_Name}} {{first-name}}')).toEqual([
      { kind: 'unknown_variable', name: 'First_Name' },
      { kind: 'unknown_variable', name: 'first-name' },
    ]));
  it('flags unclosed tags', () => expect(validateTemplate('Hi {{first_name')).toEqual([{ kind: 'unclosed_tag' }]));
});

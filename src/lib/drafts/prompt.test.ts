import { describe, expect, it } from 'vitest';
import type { LeadContext } from '@/db/schema';
import { buildDraftPrompt } from './prompt';

const ABOUT_ME = 'I moved from Paris to San Francisco right after school. I live on Folsom St.';

const context: LeadContext = {
  founder: { name: 'Jane Q. Doe', bio: 'Ex-Stripe engineer', pastCompanies: 'Stripe, Google' },
  company: {
    name: 'Acme Robotics',
    batch: 'W26',
    website: 'https://acme.example',
    oneLiner: 'Robots that fold laundry',
    description: 'We build home robots.',
    hiringDescription: 'Join a team of six.\n\nWe want engineers who ship robots, not slides.',
    teamSize: 7,
    jobs: [
      {
        title: 'Founding Engineer',
        category: 'founding_engineer',
        location: 'San Francisco, CA',
        remote: 'no',
        salary: '$150K - $200K',
        equity: '0.5% - 1%',
        url: 'https://example.com/job/1',
        description: 'Own the robot control stack.',
      },
    ],
  },
};

describe('buildDraftPrompt', () => {
  it('puts the writing rules in the developer message', () => {
    const { developer } = buildDraftPrompt(ABOUT_ME, context);
    expect(developer).toMatch(/280 characters/);
    expect(developer).toMatch(/first name/i);
    expect(developer).toMatch(/coffee/i);
    expect(developer).toMatch(/500.*900 characters/);
    expect(developer).toMatch(/office/i);
    expect(developer).toMatch(/never thank them for connecting/i);
    expect(developer).toMatch(/never mention the invite/i);
    expect(developer).toMatch(/English/);
    expect(developer).toMatch(/emoji/i);
    expect(developer).toMatch(/hashtag/i);
    expect(developer).toMatch(/link/i);
    expect(developer).toMatch(/em dash/i);
    expect(developer).toContain('{{');
    expect(developer).toMatch(/placeholder/i);
    expect(developer).toMatch(/only.*facts/i);
    // How to use the company's hiring pitch: as a guide, never as text to copy or as a fact about the owner.
    expect(developer).toMatch(/hiring pitch/i);
    expect(developer).toMatch(/do not copy/i);
    // The owner's own words and the founder's data belong in the user message only.
    expect(developer).not.toContain('Folsom');
    expect(developer).not.toContain('Acme');
    // Every fact about the owner comes from About me: the rules state none.
    expect(developer).not.toMatch(/scale|early-stage|startup/i);
  });

  it('puts the owner text and every context field in labelled sections of the user message', () => {
    const { user } = buildDraftPrompt(ABOUT_ME, context);
    expect(user).toContain(ABOUT_ME);
    for (const value of [
      'Jane',
      'Jane Q. Doe',
      'Ex-Stripe engineer',
      'Stripe, Google',
      'Acme Robotics',
      'W26',
      'https://acme.example',
      'Robots that fold laundry',
      'We build home robots.',
      'We want engineers who ship robots, not slides.',
      '7',
      'Founding Engineer',
      'founding_engineer',
      'San Francisco, CA',
      '$150K - $200K',
      '0.5% - 1%',
      'Own the robot control stack.',
    ]) {
      expect(user).toContain(value);
    }
    const about = user.indexOf('About me');
    const founder = user.indexOf('Founder');
    const company = user.indexOf('Company');
    const jobs = user.indexOf('jobs');
    expect([about, founder, company, jobs].every((i) => i >= 0)).toBe(true);
    expect(about).toBeLessThan(founder);
    expect(founder).toBeLessThan(company);
    expect(company).toBeLessThan(jobs);
  });

  it('gives the hiring pitch whole, under its own label, as the last line of the company section', () => {
    const { user } = buildDraftPrompt(ABOUT_ME, context);
    const company = user.slice(user.indexOf('## Company'), user.indexOf('## Open coding jobs')).trimEnd();
    expect(company).toContain(
      'Hiring pitch (what the company tells candidates): Join a team of six.\n\nWe want engineers who ship robots, not slides.',
    );
    // A pitch of several paragraphs comes last, so that no other field of the company follows it.
    expect(company.endsWith('We want engineers who ship robots, not slides.')).toBe(true);
  });

  it('leaves the hiring pitch out when the company has none, and for a lead uploaded before it was kept', () => {
    const none: LeadContext = { ...context, company: { ...context.company, hiringDescription: null } };
    const blank: LeadContext = { ...context, company: { ...context.company, hiringDescription: '  ' } };
    const older: LeadContext = { ...context, company: { ...context.company } };
    delete older.company.hiringDescription;
    for (const without of [none, blank, older]) {
      const { user } = buildDraftPrompt(ABOUT_ME, without);
      expect(user).not.toMatch(/hiring pitch/i);
      expect(user).not.toContain('null');
      expect(user).not.toContain('undefined');
      expect(user).toContain('We build home robots.');
    }
  });

  it('says plainly when the company has no coding job, and leaves out unknown fields', () => {
    const bare: LeadContext = {
      founder: { name: 'Sam', bio: null, pastCompanies: null },
      company: { ...context.company, batch: null, website: null, teamSize: null, jobs: [] },
    };
    const { user } = buildDraftPrompt(ABOUT_ME, bare);
    expect(user).toMatch(/no open coding job/i);
    expect(user).not.toContain('null');
    expect(user).not.toContain('Founding Engineer');
  });

  it('adds the length of the previous note on a retry only', () => {
    expect(buildDraftPrompt(ABOUT_ME, context).user).not.toMatch(/312/);
    const retry = buildDraftPrompt(ABOUT_ME, context, { previousNoteLength: 312 });
    expect(retry.user).toMatch(/312 characters/);
    expect(retry.user).toMatch(/under 280/);
  });
});

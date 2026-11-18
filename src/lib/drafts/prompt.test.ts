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
    expect(developer).toMatch(/thank/i);
    expect(developer).toMatch(/English/);
    expect(developer).toMatch(/emoji/i);
    expect(developer).toMatch(/hashtag/i);
    expect(developer).toMatch(/link/i);
    expect(developer).toMatch(/em dash/i);
    expect(developer).toContain('{{');
    expect(developer).toMatch(/placeholder/i);
    expect(developer).toMatch(/only.*facts/i);
    // The owner's own words and the founder's data belong in the user message only.
    expect(developer).not.toContain('Folsom');
    expect(developer).not.toContain('Acme');
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

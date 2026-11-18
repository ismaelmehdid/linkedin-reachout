import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENAI_MODEL, readOpenAiConfig } from './config';

describe('readOpenAiConfig', () => {
  it('reads a trimmed key and model', () => {
    expect(readOpenAiConfig({ OPENAI_API_KEY: ' sk-1\n', OPENAI_MODEL: ' gpt-x ' })).toEqual({ apiKey: 'sk-1', model: 'gpt-x' });
  });

  it('gives a null key and the default model when they are missing or blank', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-6.2-astra');
    expect(readOpenAiConfig({})).toEqual({ apiKey: null, model: 'gpt-6.2-astra' });
    expect(readOpenAiConfig({ OPENAI_API_KEY: '  ', OPENAI_MODEL: '' })).toEqual({ apiKey: null, model: 'gpt-6.2-astra' });
  });
});

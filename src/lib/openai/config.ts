export const DEFAULT_OPENAI_MODEL = 'gpt-6.2-astra';

export type OpenAiConfig = { apiKey: string | null; model: string };

/**
 * Read apart from `parseEnv` on purpose: the app runs without an OpenAI key, and only draft generation
 * reports it missing. Values are trimmed, like every other variable.
 */
export function readOpenAiConfig(source: Record<string, string | undefined> = process.env): OpenAiConfig {
  const apiKey = source.OPENAI_API_KEY?.trim() ?? '';
  const model = source.OPENAI_MODEL?.trim() ?? '';
  return { apiKey: apiKey === '' ? null : apiKey, model: model === '' ? DEFAULT_OPENAI_MODEL : model };
}

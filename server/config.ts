import type { AppConfig } from '../shared/types.js';
import { GoogleModel } from './google-model.js';
import { OpenAIModel } from './model.js';
import { TavilySearch } from './search.js';
import { ChatModel } from './chat-model.js';

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const model = env.CHAT_MODEL || env.OPENAI_MODEL || 'gpt-5.4';
  const provider = env.MODEL_PROVIDER || (model.startsWith('gemini-') ? 'google' : 'openai');
  if (!['openai', 'google', 'agentrouter'].includes(provider))
    throw new Error('MODEL_PROVIDER must be openai, google, or agentrouter.');
  const google = provider === 'google';
  // Accept the original assignment setup while providing an unambiguous canonical key.
  const modelKey = google
    ? env.GOOGLE_API_KEY || env.OPENAI_API_KEY
    : provider === 'agentrouter'
      ? env.AGENTROUTER_API_KEY || env.OPENAI_API_KEY
      : env.OPENAI_API_KEY;
  const keyName = google
    ? 'GOOGLE_API_KEY'
    : provider === 'agentrouter'
      ? 'AGENTROUTER_API_KEY'
      : 'OPENAI_API_KEY';
  const missingKeys = [
    !modelKey?.trim() ? keyName : null,
    !env.TAVILY_API_KEY?.trim() ? 'TAVILY_API_KEY' : null,
  ].filter((s): s is string => !!s);
  const config: AppConfig = {
    live: missingKeys.length === 0 && env.THREAD_DEMO_ONLY !== 'true',
    missingKeys,
    model,
    provider: provider as AppConfig['provider'],
  };
  const baseURL =
    env.OPENAI_BASE_URL || (provider === 'agentrouter' ? 'https://agentrouter.org/v1' : undefined);
  const api = env.MODEL_API || (provider === 'agentrouter' ? 'chat' : 'responses');
  if (!['chat', 'responses'].includes(api)) throw new Error('MODEL_API must be chat or responses.');
  if (baseURL) {
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('OPENAI_BASE_URL must be an HTTPS URL without embedded credentials.');
  }
  return {
    config,
    agent: config.live
      ? {
          model: google
            ? new GoogleModel(modelKey!, model)
            : api === 'chat'
              ? new ChatModel(modelKey!, model, baseURL || 'https://api.openai.com/v1')
              : new OpenAIModel(modelKey!, model, baseURL),
          search: new TavilySearch(env.TAVILY_API_KEY!),
        }
      : undefined,
  };
}

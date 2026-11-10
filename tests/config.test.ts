import { describe, expect, it } from 'vitest';
import { configuration } from '../server/config.js';
import { ChatModel } from '../server/chat-model.js';
import { GoogleModel } from '../server/google-model.js';
import { OpenAIModel } from '../server/model.js';

describe('provider selection', () => {
  it('defaults to OpenAI Responses without making a network call', () => {
    const setup = configuration({ OPENAI_API_KEY: 'test', TAVILY_API_KEY: 'test' });
    expect(setup.agent?.model).toBeInstanceOf(OpenAIModel);
  });
  it('uses AgentRouter credentials and its documented chat protocol', () => {
    const setup = configuration({
      MODEL_PROVIDER: 'agentrouter',
      AGENTROUTER_API_KEY: 'test',
      TAVILY_API_KEY: 'test',
    });
    expect(setup.agent?.model).toBeInstanceOf(ChatModel);
    expect(setup.config.provider).toBe('agentrouter');
  });
  it('supports Gemini with its own key', () => {
    const setup = configuration({
      MODEL_PROVIDER: 'google',
      CHAT_MODEL: 'gemini-2.5-flash',
      GOOGLE_API_KEY: 'test',
      TAVILY_API_KEY: 'test',
    });
    expect(setup.agent?.model).toBeInstanceOf(GoogleModel);
  });
  it('does not silently fall back to a demo or another provider for a missing key', () => {
    const setup = configuration({ MODEL_PROVIDER: 'agentrouter' });
    expect(setup.agent).toBeUndefined();
    expect(setup.config.missingKeys).toEqual(['AGENTROUTER_API_KEY', 'TAVILY_API_KEY']);
  });
  it('supports explicit Responses protocol for compatible gateways', () => {
    const setup = configuration({
      MODEL_PROVIDER: 'agentrouter',
      MODEL_API: 'responses',
      AGENTROUTER_API_KEY: 'test',
      TAVILY_API_KEY: 'test',
    });
    expect(setup.agent?.model).toBeInstanceOf(OpenAIModel);
  });
  it('rejects unknown protocols and insecure endpoints', () => {
    expect(() => configuration({ MODEL_API: 'typo' })).toThrow('MODEL_API');
    expect(() => configuration({ OPENAI_BASE_URL: 'http://example.com/v1' })).toThrow('HTTPS');
    expect(() => configuration({ MODEL_PROVIDER: 'typo' })).toThrow('MODEL_PROVIDER');
  });
  it('keeps automated browser tests offline even when a local .env contains keys', () => {
    expect(
      configuration({ OPENAI_API_KEY: 'test', TAVILY_API_KEY: 'test', THREAD_DEMO_ONLY: 'true' })
        .agent,
    ).toBeUndefined();
  });
});

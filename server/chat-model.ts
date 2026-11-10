import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';
import type { LanguageModel, ModelRequest, ModelResponse } from './model.js';
import { ProviderError, webSearchTool } from './search.js';

/** AgentRouter's documented Chat Completions transport, behind the same agent interface. */
export class ChatModel implements LanguageModel {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
    baseURL: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 45_000 });
  }
  async respond(request: ModelRequest): Promise<ModelResponse> {
    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: request.instructions },
      ];
      for (const item of request.input) {
        if (item.type === 'continuation') {
          if (item.provider !== 'chat') throw new Error('Mismatched model continuation');
          messages.push(item.value as ChatCompletionMessageParam);
        } else if (item.type === 'function_call_output')
          messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        else messages.push({ role: item.role, content: item.content });
      }
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          tools: [
            {
              type: 'function',
              function: {
                name: webSearchTool.name,
                description: webSearchTool.description,
                parameters: webSearchTool.parameters,
              },
            },
          ],
          tool_choice: request.allowSearch ? 'auto' : 'none',
          max_completion_tokens: 5000,
        },
        { signal: request.signal },
      );
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finish = '';
      const calls = new Map<number, ChatCompletionMessageFunctionToolCall>();
      for await (const chunk of stream) {
        request.signal.throwIfAborted();
        inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
        const choice = chunk.choices[0];
        if (!choice) continue;
        finish = choice.finish_reason || finish;
        if (choice.delta.content) {
          text += choice.delta.content;
          request.onDelta(choice.delta.content);
        }
        if (choice.delta.refusal) {
          text += choice.delta.refusal;
          request.onDelta(choice.delta.refusal);
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.function.name += delta.function.name;
          if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
          calls.set(delta.index, call);
        }
      }
      if (!['stop', 'tool_calls'].includes(finish))
        throw new ProviderError('model', finish || 'incomplete');
      const tools = [...calls.values()];
      return {
        text,
        calls: tools.map((call) => ({
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
        continuation: {
          type: 'continuation',
          provider: 'chat',
          value: {
            role: 'assistant',
            content: text || null,
            ...(tools.length ? { tool_calls: tools } : {}),
          } satisfies ChatCompletionMessageParam,
        },
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof ProviderError) throw error;
      if (error instanceof OpenAI.APIError)
        throw new ProviderError('model', error.status ?? 'network');
      throw new ProviderError('model', 'network');
    }
  }
}

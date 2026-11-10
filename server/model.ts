import OpenAI from 'openai';
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';
import { ProviderError, webSearchTool } from './search.js';

export interface ModelRequest {
  instructions: string;
  input: ModelInput[];
  allowSearch: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}
export type ModelInput =
  | { type: 'message'; role: 'user'; content: string }
  | { type: 'function_call_output'; call_id: string; name: string; output: string }
  | { type: 'continuation'; provider: 'openai' | 'google' | 'chat'; value: unknown };
export interface ToolCall {
  call_id: string;
  name: string;
  arguments: string;
}
export interface ModelResponse {
  calls: ToolCall[];
  continuation?: ModelInput;
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface LanguageModel {
  respond(request: ModelRequest): Promise<ModelResponse>;
}

export class OpenAIModel implements LanguageModel {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 45_000 });
  }
  async respond(request: ModelRequest): Promise<ModelResponse> {
    try {
      const input: ResponseInputItem[] = request.input.flatMap((item): ResponseInputItem[] => {
        if (item.type === 'continuation') {
          if (item.provider !== 'openai') throw new Error('Mismatched model continuation');
          return item.value as ResponseInputItem[];
        }
        if (item.type === 'function_call_output')
          return [{ type: item.type, call_id: item.call_id, output: item.output }];
        return [{ role: item.role, content: item.content }];
      });
      const stream = this.client.responses.stream(
        {
          model: this.model,
          instructions: request.instructions,
          input,
          tools: [webSearchTool],
          tool_choice: request.allowSearch ? 'auto' : 'none',
          parallel_tool_calls: false, // The single tool itself accepts a parallel batch.
          store: false,
          include: ['reasoning.encrypted_content'],
          reasoning: { effort: 'low' },
          max_output_tokens: 5000,
        },
        { signal: request.signal },
      );
      stream.on('response.output_text.delta', (event) => request.onDelta(event.delta));
      stream.on('response.refusal.delta', (event) => request.onDelta(event.delta));
      const response = await stream.finalResponse();
      if (response.status !== 'completed')
        throw new ProviderError('model', response.status ?? 'incomplete');
      const refusal = response.output
        .flatMap((item) =>
          item.type === 'message'
            ? item.content.filter((c) => c.type === 'refusal').map((c) => c.refusal)
            : [],
        )
        .join('\n');
      const continuation = response.output.filter((item: ResponseOutputItem) =>
        ['message', 'reasoning', 'function_call'].includes(item.type),
      );
      return {
        calls: response.output.filter((item) => item.type === 'function_call'),
        continuation: { type: 'continuation', provider: 'openai', value: continuation },
        text: response.output_text || refusal,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
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

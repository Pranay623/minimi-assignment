import OpenAI from 'openai';
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';
import { ProviderError, webSearchTool } from './search.js';

export interface ModelRequest {
  instructions: string;
  input: ResponseInputItem[];
  allowSearch: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}
export interface ModelResponse {
  output: ResponseOutputItem[];
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface LanguageModel { respond(request: ModelRequest): Promise<ModelResponse> }

export class OpenAIModel implements LanguageModel {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 45_000 });
  }
  async respond(request: ModelRequest): Promise<ModelResponse> {
    try {
      const stream = this.client.responses.stream({
        model: this.model,
        instructions: request.instructions,
        input: request.input,
        tools: [webSearchTool],
        tool_choice: request.allowSearch ? 'auto' : 'none',
        parallel_tool_calls: false, // The single tool itself accepts a parallel batch.
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'low' },
        max_output_tokens: 5000,
      }, { signal: request.signal });
      stream.on('response.output_text.delta', event => request.onDelta(event.delta));
      stream.on('response.refusal.delta', event => request.onDelta(event.delta));
      const response = await stream.finalResponse();
      if (response.status !== 'completed') throw new ProviderError('model', response.status ?? 'incomplete');
      const refusal = response.output.flatMap(item => item.type === 'message' ? item.content.filter(c => c.type === 'refusal').map(c => c.refusal) : []).join('\n');
      return { output: response.output, text: response.output_text || refusal,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof ProviderError) throw error;
      if (error instanceof OpenAI.APIError) throw new ProviderError('model', error.status ?? 'network');
      throw new ProviderError('model', 'network');
    }
  }
}

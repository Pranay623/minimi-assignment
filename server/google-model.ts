import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';
import type { LanguageModel, ModelRequest, ModelResponse } from './model.js';
import { ProviderError, webSearchTool } from './search.js';

const declaration: FunctionDeclaration = {
  name: webSearchTool.name,
  description: webSearchTool.description,
  parameters: {
    type: Type.OBJECT,
    required: ['queries'],
    properties: {
      queries: {
        type: Type.ARRAY,
        minItems: '1',
        maxItems: '4',
        items: {
          type: Type.OBJECT,
          required: ['query', 'domains', 'startDate', 'endDate'],
          properties: {
            query: { type: Type.STRING },
            domains: { type: Type.ARRAY, items: { type: Type.STRING } },
            startDate: { type: Type.STRING, nullable: true },
            endDate: { type: Type.STRING, nullable: true },
          },
        },
      },
    },
  },
};

export class GoogleModel implements LanguageModel {
  private client: GoogleGenAI;
  constructor(
    apiKey: string,
    private model = 'gemini-2.5-flash',
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 45_000, retryOptions: { attempts: 1 } },
    });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    try {
      const contents: Content[] = [];
      const providerIds = new Map<string, string | undefined>();
      for (const item of request.input) {
        if (item.type === 'continuation') {
          if (item.provider !== 'google') throw new Error('Mismatched model continuation');
          const previous = item.value as { content: Content; ids: [string, string | undefined][] };
          contents.push(previous.content);
          previous.ids.forEach(([local, remote]) => providerIds.set(local, remote));
        } else if (item.type === 'function_call_output') {
          const part: Part = {
            functionResponse: {
              ...(providerIds.get(item.call_id) ? { id: providerIds.get(item.call_id) } : {}),
              name: item.name,
              response: { result: JSON.parse(item.output) },
            },
          };
          const last = contents.at(-1);
          if (last?.role === 'user' && last.parts?.some((p) => p.functionResponse))
            last.parts.push(part);
          else contents.push({ role: 'user', parts: [part] });
        } else {
          const last = contents.at(-1);
          if (last?.role === 'user' && !last.parts?.some((p) => p.functionResponse))
            last.parts!.push({ text: item.content });
          else contents.push({ role: 'user', parts: [{ text: item.content }] });
        }
      }
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: request.instructions,
          abortSignal: request.signal,
          tools: [{ functionDeclarations: [declaration] }],
          toolConfig: {
            functionCallingConfig: {
              mode: request.allowSearch
                ? FunctionCallingConfigMode.AUTO
                : FunctionCallingConfigMode.NONE,
            },
          },
          ...(this.model.startsWith('gemini-2.5')
            ? { thinkingConfig: { thinkingBudget: 1024 } }
            : {}),
          maxOutputTokens: 6000,
        },
      });
      const parts: Part[] = [];
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finish = '';
      for await (const chunk of stream) {
        request.signal.throwIfAborted();
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          // Preserve thought signatures attached to tool calls, but never display thoughts.
          parts.push(part);
          if (part.text && !part.thought) {
            text += part.text;
            request.onDelta(part.text);
          }
        }
        inputTokens = chunk.usageMetadata?.promptTokenCount ?? inputTokens;
        if (chunk.usageMetadata)
          outputTokens =
            (chunk.usageMetadata.candidatesTokenCount ?? 0) +
            (chunk.usageMetadata.thoughtsTokenCount ?? 0);
        finish = chunk.candidates?.[0]?.finishReason ?? finish;
      }
      if (finish !== 'STOP') throw new ProviderError('model', finish || 'incomplete');
      const calls = parts
        .filter((part) => part.functionCall)
        .map((part, i) => {
          const call = part.functionCall!;
          // Stable IDs join results to calls, including Gemini versions that omit IDs.
          const id = call.id || `search_${contents.length}_${i}`;
          providerIds.set(id, call.id);
          return { call_id: id, name: call.name || '', arguments: JSON.stringify(call.args ?? {}) };
        });
      return {
        text,
        calls,
        continuation: {
          type: 'continuation',
          provider: 'google',
          value: {
            content: { role: 'model', parts } satisfies Content,
            ids: [...providerIds.entries()],
          },
        },
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof ProviderError) throw error;
      if (error instanceof ApiError) throw new ProviderError('model', error.status);
      throw new ProviderError('model', 'network');
    }
  }
}

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse, GoogleGenAI } from '@google/genai';
import { OpenAIModel, type ModelRequest } from '../server/model.js';
import { ChatModel } from '../server/chat-model.js';
import { GoogleModel } from '../server/google-model.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function endpoint(events: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    bodies.push(JSON.parse(text));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, bodies };
}
const request = (): ModelRequest => ({
  instructions: 'Test instructions',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  allowSearch: true,
  signal: new AbortController().signal,
  onDelta: vi.fn(),
});

describe('real SDK streaming against controlled HTTP', () => {
  it('decodes Responses SSE, preserves usage, and sends exactly one stateless function tool', async () => {
    const response = {
      id: 'r1',
      object: 'response',
      created_at: 1,
      status: 'in_progress',
      model: 'test',
      output: [],
    };
    const message = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    };
    const http = await endpoint([
      { type: 'response.created', sequence_number: 0, response },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { ...message, content: [] },
      },
      {
        type: 'response.content_part.added',
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 3,
        output_index: 0,
        content_index: 0,
        delta: 'Hello',
      },
      {
        type: 'response.completed',
        sequence_number: 4,
        response: {
          ...response,
          status: 'completed',
          output: [message],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        },
      },
    ]);
    const input = request();
    const result = await new OpenAIModel('fake-test-key', 'test', http.baseURL).respond(input);
    expect(result.text).toBe('Hello');
    expect(result.inputTokens).toBe(12);
    expect(input.onDelta).toHaveBeenCalledWith('Hello');
    expect(http.bodies[0]).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
    });
    expect(http.bodies[0]?.tools).toHaveLength(1);
  });
  it('reassembles streamed Chat Completions tool arguments and carries tool results', async () => {
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    });
    const http = await endpoint([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"que' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ries":[]}' } }] }, 'tool_calls'),
      { ...chunk({}), choices: [], usage: { prompt_tokens: 8, completion_tokens: 5 } },
    ]);
    const result = await new ChatModel('fake', 'test', http.baseURL).respond(request());
    expect(result.calls).toEqual([
      { call_id: 'call1', name: 'web_search', arguments: '{"queries":[]}' },
    ]);
    expect(result.inputTokens).toBe(8);
    expect(result.outputTokens).toBe(5);
    expect(http.bodies[0]?.tools).toHaveLength(1);
    expect(result.continuation?.type).toBe('continuation');
  });
  it('rejects a truncated answer instead of treating length exhaustion as success', async () => {
    const http = await endpoint([
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test',
        choices: [{ index: 0, delta: { content: 'Half an answer' }, finish_reason: 'length' }],
      },
    ]);
    await expect(new ChatModel('fake', 'test', http.baseURL).respond(request())).rejects.toThrow(
      'request failed',
    );
  });
});

it('preserves Gemini thought signatures unchanged across the tool round and suppresses thoughts', async () => {
  const original = {
    functionCall: { name: 'web_search', args: { queries: [] } },
    thoughtSignature: 'opaque-signature',
  };
  let round = 0;
  const generate = vi.fn(async function* () {
    const parts =
      round++ === 0
        ? [original]
        : [{ thought: true, text: 'private reasoning' }, { text: 'Public answer' }];
    yield {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
    } as GenerateContentResponse;
  });
  const client = { models: { generateContentStream: generate } } as unknown as Pick<
    GoogleGenAI,
    'models'
  >;
  const model = new GoogleModel('fake', 'gemini-2.5-flash', client);
  const first = await model.respond(request());
  const next = request();
  next.input.push(first.continuation!, {
    type: 'function_call_output',
    call_id: first.calls[0]!.call_id,
    name: 'web_search',
    output: '{"sources":[]}',
  });
  const second = await model.respond(next);
  expect(second.text).toBe('Public answer');
  expect(second.outputTokens).toBe(5);
  expect(next.onDelta).not.toHaveBeenCalledWith('private reasoning');
  const call = generate.mock.calls[1] as unknown as [
    { contents: { role: string; parts: unknown[] }[] },
  ];
  expect(call[0].contents.find((c) => c.role === 'model')?.parts).toEqual([original]);
  expect(original.functionCall).not.toHaveProperty('id');
});

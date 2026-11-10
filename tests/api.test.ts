import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { LanguageModel } from '../server/model.js';
import { readEvents } from '../src/api.js';
import type { AgentEvent } from '../shared/types.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup(live = true) {
  const store = new Store();
  stores.push(store);
  const model: LanguageModel = {
    respond: vi.fn(async (input) => {
      input.onDelta('Hello!');
      return { text: 'Hello!', calls: [], inputTokens: 3, outputTokens: 2 };
    }),
  };
  const { app } = createApp({
    store,
    config: {
      live,
      missingKeys: live ? [] : ['OPENAI_API_KEY', 'TAVILY_API_KEY'],
      model: 'test-model',
    },
    agent: { model, search: { search: async () => [] } },
  });
  return { store, app, model, browser: request.agent(app) };
}
describe('HTTP boundary', () => {
  it('creates a durable HTTP-only identity and owner-scoped conversation', async () => {
    const h = setup();
    const config = await h.browser.get('/api/config').expect(200);
    expect(config.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(config.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
    const chat = await h.browser.post('/api/conversations').send({}).expect(201);
    const listing = await h.browser.get('/api/conversations').expect(200);
    expect(listing.body).toHaveLength(1);
    await request.agent(h.app).get(`/api/conversations/${chat.body.id}`).expect(404);
  });
  it('does not accept a user-provided identity', async () => {
    const h = setup();
    const res = await h.browser
      .get('/api/config')
      .set('Cookie', 'thread_session=attacker')
      .expect(200);
    expect(res.headers['set-cookie']?.[0]).not.toContain('=attacker');
  });
  it('blocks cross-origin access and cross-site writes', async () => {
    const h = setup();
    await h.browser.get('/api/config').set('Origin', 'https://evil.example').expect(403);
    await h.browser
      .post('/api/conversations')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(403);
  });
  it('blocks DNS rebinding through an unrecognized Host', async () => {
    const h = setup();
    await h.browser.get('/api/config').set('Host', 'attacker.example').expect(403);
  });
  it('validates messages, timezone and body size', async () => {
    const h = setup();
    const chat = await h.browser.post('/api/conversations').send({});
    const url = `/api/conversations/${chat.body.id}/turns`;
    await h.browser
      .post(url)
      .send({ id: randomUUID(), message: 'hello', timezone: 'Mars' })
      .expect(400);
    await h.browser.post(url).send({ id: randomUUID(), message: ' ', timezone: 'UTC' }).expect(400);
    await h.browser
      .post(url)
      .send({ id: randomUUID(), message: 'a'.repeat(22000), timezone: 'UTC' })
      .expect(413);
  });
  it('streams a complete turn and replays its idempotency key without another model call', async () => {
    const h = setup();
    const chat = await h.browser.post('/api/conversations').send({});
    const url = `/api/conversations/${chat.body.id}/turns`;
    const body = { id: randomUUID(), message: 'hello', timezone: 'UTC' };
    const first = await h.browser.post(url).send(body).expect(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    expect(first.text).toContain('"type":"done"');
    const second = await h.browser.post(url).send(body).expect(200);
    expect(second.text).toContain('"answer":"Hello!"');
    expect(h.model.respond).toHaveBeenCalledTimes(1);
    await h.browser
      .post(url)
      .send({ ...body, message: 'different message' })
      .expect(409);
  });
  it('returns an actionable key error without silently substituting demo answers', async () => {
    const h = setup(false);
    const chat = await h.browser.post('/api/conversations').send({});
    const response = await h.browser
      .post(`/api/conversations/${chat.body.id}/turns`)
      .send({ id: randomUUID(), message: 'hi', timezone: 'UTC' })
      .expect(503);
    expect(response.body.error).toContain('OPENAI_API_KEY');
    expect(h.model.respond).not.toHaveBeenCalled();
  });
  it('makes demo setup idempotent and deletes associated turns', async () => {
    const h = setup(false);
    const first = await h.browser.post('/api/demo').send({}).expect(200);
    const second = await h.browser.post('/api/demo').send({}).expect(200);
    expect(first.body.id).toBe(second.body.id);
    const contents = await h.browser.get(`/api/conversations/${first.body.id}`).expect(200);
    expect(contents.body.turns).toHaveLength(2);
    expect(contents.body.turns[0].answer).toContain('fictional');
    await h.browser.delete(`/api/conversations/${first.body.id}`).expect(204);
    await h.browser.get(`/api/conversations/${first.body.id}`).expect(404);
  });
  it('limits burst requests', async () => {
    const h = setup();
    await h.browser.get('/api/config');
    for (let i = 0; i < 12; i++) await h.browser.post('/api/conversations').send({}).expect(201);
    await h.browser.post('/api/conversations').send({}).expect(429);
  });
});

describe('stream decoding', () => {
  it('preserves split UTF-8, multiline events, CRLF, and heartbeat frames', async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode(
      ': heartbeat\r\n\r\ndata: {"type":"delta",\r\ndata: "text":"₹ café 🧵"}\r\n\r\ndata: {"type":"status","message":"done"}\n\n',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of payload) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const events: AgentEvent[] = [];
    await readEvents(stream, (event) => events.push(event));
    expect(events).toEqual([
      { type: 'delta', text: '₹ café 🧵' },
      { type: 'status', message: 'done' },
    ]);
  });
});

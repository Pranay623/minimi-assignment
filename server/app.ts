import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { AgentEvent, AppConfig, Turn } from '../shared/types.js';
import type { Store } from './db.js';
import { runAgent, type AgentDependencies } from './agent.js';
import { DEMO_DATE, runDemo, seedDemo } from './demo.js';

const chatInput = z
  .object({
    id: z.uuid(),
    message: z.string().trim().min(1).max(12_000),
    timezone: z
      .string()
      .max(80)
      .refine((zone) => DateTime.now().setZone(zone).isValid, 'Invalid IANA timezone'),
  })
  .strict();

export interface AppDependencies {
  store: Store;
  config: AppConfig;
  agent?: Omit<AgentDependencies, 'store'>;
  publicOrigin?: string;
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Local by default, including Host validation against DNS rebinding.
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (deps.publicOrigin) allowedHosts.add(new URL(deps.publicOrigin).hostname);
    try {
      if (!allowedHosts.has(new URL(`http://${req.get('host')}`).hostname)) {
        res
          .status(403)
          .json({ error: 'Host is not allowed. Configure PUBLIC_ORIGIN for a deployed instance.' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Invalid Host header.' });
      return;
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Invalid origin.' });
        return;
      }
    }
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Cross-site requests are not allowed.' });
      return;
    }
    next();
  });
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    let token = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('thread_session='))
      ?.slice(15);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !deps.store.hasOwner(hash(token))) {
      token = randomBytes(32).toString('hex');
      deps.store.createOwner(hash(token));
      res.cookie('thread_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        maxAge: 365 * 24 * 3600_000,
        path: '/',
      });
    }
    res.locals.owner = hash(token);
    next();
  });
  const owner = (res: Response): string => res.locals.owner as string;
  // Single-process quotas. Owner-wide serialization prevents inconsistent cross-chat baselines.
  const active = new Map<string, AbortController>();
  const rates = new Map<string, number[]>();
  const limit = (res: Response) => {
    const who = owner(res);
    const now = Date.now();
    for (const [key, timestamps] of rates)
      if (!timestamps.some((t) => now - t < 60_000)) rates.delete(key);
    const recent = (rates.get(who) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 12 || active.size >= 4) {
      res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
      return false;
    }
    rates.set(who, [...recent, now]);
    return true;
  };
  app.get('/api/config', (_req, res) => {
    res.json(deps.config);
  });
  app.get('/api/conversations', (_req, res) => {
    res.json(deps.store.conversations(owner(res)));
  });
  app.post('/api/conversations', (_req, res) => {
    if (limit(res)) res.status(201).json(deps.store.createConversation(owner(res)));
  });
  app.post('/api/demo', (_req, res) => {
    if (limit(res)) res.json(seedDemo(deps.store, owner(res)));
  });
  app.get('/api/conversations/:id', (req, res) => {
    const chat = deps.store.conversation(owner(res), String(req.params.id));
    if (!chat) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ conversation: chat, turns: deps.store.turns(owner(res), chat.id) });
  });
  app.delete('/api/conversations/:id', (req, res) => {
    if (active.has(owner(res))) {
      res.status(409).json({ error: 'Stop the current response before deleting.' });
      return;
    }
    if (!deps.store.deleteConversation(owner(res), String(req.params.id))) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.status(204).end();
  });
  app.post('/api/conversations/:id/turns', async (req, res) => {
    const parsed = chatInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          'Enter a message (up to 12,000 characters), a UUID request id, and a valid timezone.',
      });
      return;
    }
    const who = owner(res);
    const chat = deps.store.conversation(who, String(req.params.id));
    if (!chat) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    if (!chat.demo && (!deps.config.live || !deps.agent)) {
      res.status(503).json({
        error:
          'Add OPENAI_API_KEY and TAVILY_API_KEY to .env, then restart the server. The sample walkthrough works without keys.',
      });
      return;
    }
    const previous = deps.store.turn(who, parsed.data.id);
    if (
      previous &&
      (previous.conversationId !== chat.id || previous.question !== parsed.data.message)
    ) {
      res.status(409).json({ error: 'Request id already belongs to a different message.' });
      return;
    }
    if (previous?.status === 'pending' || active.has(who)) {
      res
        .status(409)
        .json({ error: 'A response is already running. Stop it or wait for it to finish.' });
      return;
    }
    if (!previous && !limit(res)) return;
    const controller = new AbortController();
    const turn =
      previous ??
      deps.store.beginTurn(
        who,
        chat.id,
        parsed.data.id,
        parsed.data.message,
        chat.demo ? DEMO_DATE : undefined,
      );
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const emit = (event: AgentEvent) => {
      if (res.destroyed || res.writableEnded) return;
      // Disconnect a stalled client before unbounded SSE buffering can consume memory.
      if (res.writableLength > 1_000_000) {
        controller.abort();
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    if (previous) {
      emit({ type: 'done', turn: previous });
      res.end();
      return;
    }
    active.set(who, controller);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 15_000);
    try {
      if (chat.demo) await runDemo(deps.store, who, turn, controller.signal, emit);
      else
        await runAgent(
          { store: deps.store, ...deps.agent! },
          { owner: who, turn, timezone: parsed.data.timezone, signal: controller.signal, emit },
        );
    } catch {
      const pending = deps.store.turn(who, turn.id);
      if (pending?.status === 'pending')
        deps.store.finishTurn(who, { ...pending, status: 'failed' });
      emit({
        type: 'error',
        message: 'The response could not be saved. Please refresh before retrying.',
      });
    } finally {
      clearInterval(heartbeat);
      active.delete(who);
      res.end();
    }
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
    res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({
      error:
        status === 413
          ? 'Request is too large.'
          : status === 400
            ? 'Invalid JSON request.'
            : 'An unexpected server error occurred.',
    });
  });
  return {
    app,
    shutdown: () => {
      for (const controller of active.values()) controller.abort();
    },
  };
}

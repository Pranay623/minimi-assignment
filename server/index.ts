import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './db.js';
import { createApp } from './app.js';
import { configuration } from './config.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const { config, agent } = configuration();
const store = new Store(process.env.DATABASE_PATH || './data/agent.sqlite');
const { app, shutdown } = createApp({
  store,
  config,
  agent,
  publicOrigin: process.env.PUBLIC_ORIGIN,
});
const server = createHttpServer(app);
const production = import.meta.url.endsWith('/dist/server/index.js');
let closeVite: (() => Promise<void>) | undefined;
if (production) {
  const root = resolve('dist/client');
  if (!existsSync(resolve(root, 'index.html')))
    throw new Error('Run npm run build before npm start.');
  app.use(express.static(root));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(resolve(root, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
server.listen(port, host, () => {
  console.log(`\nThread is ready at http://localhost:${port}`);
  console.log(
    config.live
      ? `Live chat enabled · ${config.model}\n`
      : `Offline walkthrough available. Live chat needs: ${config.missingKeys.join(', ') || 'demo-only mode disabled'}\n`,
  );
});
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.once(event, () => {
    shutdown();
    server.close(async () => {
      await closeVite?.();
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });

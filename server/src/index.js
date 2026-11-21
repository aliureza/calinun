import fs from 'node:fs';
import { createConfig } from './config.js';
import { Store } from './store.js';
import { createUpstream } from './upstream.js';
import { createPusher } from './push.js';
import { createScheduler } from './scheduler.js';
import { createApp } from './app.js';

// Optional .env loader (KEY=VALUE per line); real environment variables always win.
const envFile = process.env.ENV_FILE || '.env';
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

let cfg;
try {
  cfg = createConfig(process.env);
} catch (e) {
  console.error(`\n✖ Configuration error: ${e.message}\n  See server/.env.example (run "npm run keys" to generate secrets).\n`);
  process.exit(1);
}

const store = new Store(cfg.dataDir, cfg.masterKey);
const upstream = createUpstream(cfg);
const pusher = createPusher({ cfg, upstream });
const scheduler = createScheduler({ cfg, store, upstream, pusher });
const { server } = createApp({ cfg, store, upstream, pusher, scheduler });

if (!pusher.enabled) console.warn('! VAPID keys are not set — push notifications are disabled.');

server.listen(cfg.port, cfg.host, () => {
  console.log(`Cullinon server listening on ${cfg.host}:${cfg.port}`);
  console.log(`  public URL : ${cfg.publicUrl}`);
  console.log(`  app origin : ${cfg.appOrigin}`);
  console.log(`  upstream   : ${cfg.allowedHosts.join(', ')}`);
  console.log(`  refresh    : every ${cfg.refreshMinutes} min, ${cfg.weeksBack} week(s) back / ${cfg.weeksAhead} ahead`);
});
scheduler.start();

const shutdown = () => { scheduler.stop(); store.flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

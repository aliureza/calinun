// Builds the static PWA into ./dist (used by GitHub Actions; also runnable locally).
//   API_URL=https://api.example.com node scripts/build-web.mjs      → live mode
//   node scripts/build-web.mjs                                       → demo mode (no backend)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'web');
const out = path.join(root, 'dist');

const apiUrl = (process.env.API_URL || '').trim().replace(/\/+$/, '');
let connectSrc = '';
if (apiUrl) {
  const u = new URL(apiUrl); // throws on garbage
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
    throw new Error('API_URL must be https:// (tokens must never travel over plain HTTP)');
  }
  connectSrc = u.origin;
}
const version = (process.env.GITHUB_SHA || 'dev').slice(0, 7);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, {
  recursive: true,
  filter: (p) => !/[\\/]test([\\/]|$)/.test(p) && !p.endsWith('.gitkeep'),
});

fs.writeFileSync(path.join(out, 'config.js'),
  `window.CULLINON = ${JSON.stringify({ apiUrl, version })};\n`);

const indexPath = path.join(out, 'index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('__CONNECT_SRC__', connectSrc));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// Content-hash → service-worker cache name, so every deploy invalidates old caches.
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name !== 'sw.js') files.push(p);
  }
})(out);
const h = crypto.createHash('sha1');
for (const f of files.sort()) h.update(path.relative(out, f)).update(fs.readFileSync(f));
const buildId = h.digest('hex').slice(0, 10);
const swPath = path.join(out, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replaceAll('__BUILD_ID__', buildId));

for (const required of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png']) {
  if (!fs.existsSync(path.join(out, required))) throw new Error(`Missing ${required}`);
}
console.log(`✔ built dist/ — ${apiUrl ? `LIVE mode (${connectSrc})` : 'DEMO mode (no API_URL)'} · build ${buildId} · ${version}`);

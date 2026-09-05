// Render the mermaid diagrams in docs/architecture.md to PNG with headless Chrome over CDP.
// No npm dependencies: Node 22 global fetch/WebSocket + Chrome DevTools Protocol.
// Usage: node scripts/render-diagrams.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const root = path.resolve(new URL('..', import.meta.url).pathname);
const md = await fs.readFile(path.join(root, 'docs/architecture.md'), 'utf8');
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]);
const names = ['architecture', 'payment-flow'];
if (blocks.length !== names.length) throw new Error(`expected ${names.length} mermaid blocks, found ${blocks.length}`);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#fff;font-family:-apple-system,Helvetica,Arial,sans-serif}.wrap{padding:24px;display:block;width:max-content}</style>
</head><body>
${blocks.map((b, i) => `<div class="wrap" id="d${i}"><pre class="mermaid">${esc(b)}</pre></div>`).join('\n')}
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose', flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false }, sequence: { useMaxWidth: false } });
try { await mermaid.run({ querySelector: '.mermaid' }); document.body.dataset.done = '1'; }
catch (e) { document.body.dataset.done = 'error:' + (e && e.message ? e.message : String(e)); }
</script></body></html>`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vr-diagrams-'));
const htmlPath = path.join(tmp, 'diagrams.html');
await fs.writeFile(htmlPath, html);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=2000,1400', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://localhost:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
if (!targets) { chrome.kill(); throw new Error('Chrome did not start'); }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1400, deviceScaleFactor: Number(process.env.DIAGRAM_SCALE || 1), mobile: false });
await send('Page.navigate', { url: 'file://' + htmlPath });
let done = '';
for (let i = 0; i < 120; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.body && document.body.dataset.done || ""', returnByValue: true });
  done = r.result?.result?.value || ''; if (done) break; await sleep(250);
}
if (done !== '1') { chrome.kill(); throw new Error('mermaid render failed: ' + (done || 'timeout')); }
for (let i = 0; i < names.length; i++) {
  const r = await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('#d${i}'); const b = el.getBoundingClientRect(); return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height }; })()`, returnByValue: true });
  const clip = { ...r.result.result.value, scale: 1 };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  const out = path.join(root, 'docs', `${names[i]}.png`);
  await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`${out}  ${Math.round(clip.width)}x${Math.round(clip.height)} css px`);
}
ws.close(); chrome.kill();
await fs.rm(tmp, { recursive: true, force: true });

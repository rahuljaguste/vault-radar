// Export the deck's native HTML diagrams to the PNGs the docs and dashboard use.
// The deck (deck/index.html, slides 04 and 05) is the single source of truth for both
// diagrams; this script screenshots them out of the deck in headless Chrome over CDP.
// No npm dependencies, same pattern as scripts/render-deck.mjs.
//
// Usage:  node scripts/render-diagrams.mjs
// Env:    CHROME_BIN      Chrome executable (default: macOS Chrome path)
//         DIAGRAM_SCALE   PNG scale factor (default 2 → ~2300 px wide)
//
// Output: docs/architecture.png, docs/payment-flow.png (+ mirrored to
//         packages/dashboard/public/docs-assets/, which the /docs pages serve)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = Number(process.env.DIAGRAM_SCALE || 2);
const PAD = 20; // breathing room so the exported PNG is not edge-to-edge
const PORT = 9223;
const root = path.resolve(new URL('..', import.meta.url).pathname);
const deckUrl = 'file://' + path.join(root, 'deck', 'index.html');

const jobs = [
  { selector: '.arch', out: 'docs/architecture.png' },
  { selector: '.pflow', out: 'docs/payment-flow.png' },
];

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'vr-diagrams-' + process.pid)}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', `--window-size=1280,760`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = msg => { chrome.kill(); throw new Error(msg); };

let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://localhost:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
if (!targets) die('Chrome did not start');
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: SCALE, mobile: false });
await send('Page.navigate', { url: deckUrl });

// Same readiness contract as render-deck.mjs: the deck sets its own flag once laid
// out, and the fonts must be in before clipping boxes (both diagrams are pure
// HTML/CSS, so fonts ARE the rendering).
let ready = '';
for (let i = 0; i < 120; i++) {
  const r = await send('Runtime.evaluate', { expression: `(() => {
    if (!document.body || document.body.dataset.deckReady !== '1') return '';
    if (document.fonts && document.fonts.status !== 'loaded') return '';
    return 'ok';
  })()`, returnByValue: true });
  ready = r.result?.result?.value || '';
  if (ready) break; await sleep(250);
}
if (ready !== 'ok') die('deck did not become ready: ' + (ready || 'timeout'));

for (const j of jobs) {
  // Pad for breathing room, but never let the bottom pad cross into the slide's
  // footer — the divider line there would ship inside the exported PNG.
  const r = await send('Runtime.evaluate', { expression: `(() => {
    const el = document.querySelector('${j.selector}');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const footer = el.closest('.slide')?.querySelector('.footer');
    const maxY = footer ? Math.min(b.bottom + ${PAD}, footer.getBoundingClientRect().top - 6) : b.bottom + ${PAD};
    return { x: b.x + window.scrollX - ${PAD}, y: b.y + window.scrollY - ${PAD},
             width: b.width + 2 * ${PAD}, height: maxY - b.top + ${PAD} };
  })()`, returnByValue: true });
  const box = r.result?.result?.value;
  if (!box) die('diagram not found in the deck: ' + j.selector);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: SCALE }, captureBeyondViewport: true });
  const out = path.join(root, j.out);
  await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
  // The dashboard's /docs pages serve these same PNGs from public/docs-assets —
  // lib/docs.ts rewrites image hrefs there — so keep that copy in sync, not drifting.
  const asset = path.join(root, 'packages/dashboard/public/docs-assets', path.basename(j.out));
  await fs.copyFile(out, asset);
  console.log(`${j.out}  ${Math.round(box.width * SCALE)}x${Math.round(box.height * SCALE)} px  (mirrored to ${path.relative(root, asset)})`);
}
ws.close(); chrome.kill();

#!/usr/bin/env node
// MEASURED: the daily scoreboard on github.com/Waleee7. "If it isn't measured, it didn't count."
//
// Zero dependencies, Node 22+.
//   node measured/build.mjs                 measure live status, response time, stars, last push
//   node measured/build.mjs --lighthouse    also run Lighthouse (mobile) on every live site via npx
//   node measured/build.mjs --render-only   re-render from measured/data.json without measuring
//
// Writes measured/data.json, measured/board.svg, measured/<slug>.svg and the README block between
// the MEASURED markers. Anything that could not be measured renders as an em dash: nothing is
// carried over from a previous run and nothing is estimated. Test counts come from projects.json,
// each with the date it was measured.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, '..', 'README.md');
const DATA = join(HERE, 'data.json');
const LIGHTHOUSE = 'lighthouse@13.6.0';
const SAMPLES = 3; // full HTML loads per site, each over a fresh connection; the median is reported
const TIMEOUT_MS = 15000;
const DASH = '—';
const BOARD_URL = 'https://github.com/Waleee7/Waleee7/actions/workflows/measured.yml';

const config = JSON.parse(readFileSync(join(HERE, 'projects.json'), 'utf8'));
const argv = new Set(process.argv.slice(2));

// ---------------------------------------------------------------- measuring

function loadOnce(url, deadline, hops = 0) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      agent: false,
      headers: { 'user-agent': 'measured-board/1.0', accept: 'text/html,*/*;q=0.8', 'accept-encoding': 'br, gzip' },
    }, (res) => {
      const { statusCode: status, headers } = res;
      if (status >= 300 && status < 400 && headers.location && hops < 5) {
        res.resume();
        resolve(loadOnce(new URL(headers.location, url).href, deadline, hops + 1));
        return;
      }
      res.on('data', () => {});
      res.on('end', () => resolve({ status }));
      res.on('error', (e) => resolve({ error: e.code || 'ERROR' }));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), Math.max(deadline - Date.now(), 1));
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => resolve({ error: e.code || 'ERROR' }));
  });
}

async function probe(url) {
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const r = await loadOnce(url, Date.now() + TIMEOUT_MS);
    runs.push({ ...r, ms: performance.now() - t0 });
  }
  const ok = runs.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms).sort((a, b) => a - b);
  if (ok.length * 2 > runs.length) {
    const mid = ok.length >> 1;
    return { up: true, ms: Math.round(ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2) };
  }
  const seen = runs.find((r) => r.status);
  return { up: false, reason: seen ? `HTTP ${seen.status}` : runs.some((r) => r.error === 'TIMEOUT') ? 'TIMEOUT' : 'NO RESPONSE' };
}

async function repoStats(repo) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'measured-board/1.0' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.private) throw new Error('private repo, not shown');
    return { stars: j.stargazers_count, pushedAt: j.pushed_at };
  } catch (e) {
    console.warn(`  github ${repo}: ${e.message}`);
    return { stars: null, pushedAt: null };
  }
}

function lighthouse(url) {
  const dir = mkdtempSync(join(tmpdir(), 'measured-lh-'));
  const out = join(dir, 'lhr.json');
  try {
    const r = spawnSync('npx', ['--yes', LIGHTHOUSE, url,
      '--only-categories=performance,accessibility',
      '--output=json', `--output-path=${out}`, '--quiet',
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
    ], { encoding: 'utf8', timeout: 240000 });
    if (r.status !== 0) throw new Error((r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n').pop());
    const lhr = JSON.parse(readFileSync(out, 'utf8'));
    if (lhr.runtimeError?.code) throw new Error(lhr.runtimeError.code);
    const score = (id) => (typeof lhr.categories[id]?.score === 'number' ? Math.round(lhr.categories[id].score * 100) : null);
    return { perf: score('performance'), a11y: score('accessibility') };
  } catch (e) {
    console.warn(`  lighthouse ${url}: ${e.message}`);
    return { perf: null, a11y: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function measure() {
  const at = new Date().toISOString();
  const rows = [];
  for (const p of config.projects) {
    const live = await probe(p.url);
    const gh = await repoStats(p.repo);
    rows.push({ slug: p.slug, live, ...gh, lighthouse: { perf: null, a11y: null } });
    console.log(`${p.slug.padEnd(16)} ${live.up ? `UP ${live.ms} ms` : `DOWN ${live.reason}`}  stars ${gh.stars ?? DASH}  pushed ${gh.pushedAt ?? DASH}`);
  }
  if (argv.has('--lighthouse')) {
    for (const [i, p] of config.projects.entries()) {
      rows[i].lighthouse = lighthouse(p.url);
      console.log(`${p.slug.padEnd(16)} lighthouse perf ${rows[i].lighthouse.perf ?? DASH} a11y ${rows[i].lighthouse.a11y ?? DASH}`);
    }
  }
  const runner = process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local';
  return { at, runner, lighthouse: argv.has('--lighthouse') ? LIGHTHOUSE : null, rows };
}

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function asOf(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return {
    board: `${parts.month.toUpperCase()} ${parts.day} ${parts.year} · ${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`,
    text: `${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`,
  };
}

function day(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return { board: `${month.toUpperCase()} ${d.getUTCDate()}`, text: `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}` };
}

function ago(iso, now) {
  if (!iso) return null;
  const min = Math.max(1, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  const unit = (n, short, long) => ({ board: `${n}${short}`, text: `${n} ${long}${n === 1 ? '' : 's'} ago` });
  if (min < 60) return unit(min, 'm', 'minute');
  const h = Math.round(min / 60);
  if (h < 48) return unit(h, 'h', 'hour');
  const d = Math.round(h / 24);
  if (d < 14) return unit(d, 'd', 'day');
  const w = Math.round(d / 7);
  if (w < 9) return unit(w, 'w', 'week');
  return unit(Math.round(d / 30.44), 'mo', 'month');
}

// ---------------------------------------------------------------- type and color

const FONTS = {
  b6: { family: 'Barlow Condensed', weight: 600, file: 'barlow-condensed-600.woff2' },
  b5: { family: 'Barlow Condensed', weight: 500, file: 'barlow-condensed-500.woff2' },
  m7: { family: 'JetBrains Mono', weight: 700, file: 'jetbrains-mono-700.woff2' },
};
const METRICS = JSON.parse(readFileSync(join(HERE, 'fonts', 'metrics.json'), 'utf8'));
const METRIC_KEY = { b6: 'barlow-condensed-600', b5: 'barlow-condensed-500', m7: 'jetbrains-mono-700' };
const FONT_DATA = Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, readFileSync(join(HERE, 'fonts', f.file)).toString('base64')]));

const C = { bg: '#0A0C10', amber: '#FFB000', chalk: '#F2EFE6', dim: '#9A978F', rule: '#272C36', hair: '#1A1E26', up: '#22C55E', down: '#EF4444' };
const STACK = {
  b: "'Barlow Condensed','Arial Narrow','Roboto Condensed','Helvetica Neue',Arial,sans-serif",
  m: "'JetBrains Mono','Fira Code','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace",
};

// Width of a string in px, from the embedded font's advance widths (kerning ignored).
function width(s, font, size, tracking = 0) {
  const m = METRICS[METRIC_KEY[font]];
  let units = 0;
  for (const ch of s) units += m.advances[ch.codePointAt(0)] ?? m.advances[78];
  return (units / m.unitsPerEm) * size + tracking * size * [...s].length;
}

// The largest size (stepping down by 0.5px) at which `s` fits in `max` px.
function fit(s, font, size, max, tracking = 0, min = 11) {
  while (size > min && width(s, font, size, tracking) > max) size -= 0.5;
  return size;
}

function style(used) {
  const faces = [...used].map((k) => `@font-face{font-family:'${FONTS[k].family}';font-weight:${FONTS[k].weight};src:url(data:font/woff2;base64,${FONT_DATA[k]}) format('woff2')}`).join('');
  return `<style>${faces}
.b6{font-family:${STACK.b};font-weight:600}.b5{font-family:${STACK.b};font-weight:500}.m7{font-family:${STACK.m};font-weight:700}
.c{fill:${C.chalk}}.a{fill:${C.amber}}.d{fill:${C.dim}}</style>`;
}

// One <text> run. `track` is letter-spacing in em. Trailing tracking is cancelled for end-anchored runs.
function text(x, y, s, { font = 'b6', size = 14, color = 'c', anchor = 'start', track = 0 } = {}) {
  const shift = anchor === 'end' && track ? track * size : 0;
  const ls = track ? ` letter-spacing="${+(track * size).toFixed(2)}"` : '';
  const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  return `<text x="${+(x + shift).toFixed(2)}" y="${y}" class="${font} ${color}" font-size="${size}"${ls}${a}>${esc(s)}</text>`;
}

const rule = (x1, x2, y, color = C.rule) => `<path d="M${x1} ${y + 0.5}H${x2}" stroke="${color}" stroke-width="1"/>`;
const dot = (cx, cy, r, up) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${up ? C.up : C.down}"/>`;

function star(cx, cy, r, fill) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

// ---------------------------------------------------------------- the board

function view(data) {
  return config.projects.map((p) => {
    const r = data.rows.find((x) => x.slug === p.slug) || { live: null, stars: null, pushedAt: null, lighthouse: {} };
    const tested = p.tests ? { count: p.tests.count, day: day(p.tests.measured), suite: p.tests.suite, flaky: p.tests.flaky || 0 } : null;
    return { ...p, ...r, tested, pushed: ago(r.pushedAt, data.at) };
  });
}

function board(data) {
  const W = 840, L = 28, R = W - 28;
  const rows = view(data);
  const stamp = asOf(data.at);
  const HEAD = 78, COLS = 46, ROW = 46, FOOT = 62;
  const top = HEAD + COLS;
  const H = top + rows.length * ROW + FOOT;
  // Right edges of the number columns. TESTS leaves a slot for a flaky asterisk before its date
  // label, and LAST PUSH sits far enough right that a "10mo" never touches that label.
  const x = { live: 232, perf: 440, a11y: 508, tests: 580, push: 724, stars: R };
  const out = [];

  // header
  out.push(text(L, 47, 'AKINWALE DARE', { size: 25, track: 0.14 }));
  const after = L + width('AKINWALE DARE', 'b6', 25, 0.14) + 6;
  out.push(text(after, 47, '·', { size: 25, color: 'd' }));
  out.push(text(after + width('·', 'b6', 25) + 10, 47, 'MEASURED', { size: 25, track: 0.14 }));
  out.push(text(R, 47, stamp.board, { font: 'm7', size: 15, color: 'a', anchor: 'end' }));
  out.push(text(R - width(stamp.board, 'm7', 15) - 12, 47, 'AS OF', { size: 11.5, color: 'd', anchor: 'end', track: 0.16 }));
  out.push(rule(L, R, HEAD - 1));

  // column heads, with the Lighthouse group label above PERF and A11Y
  const gy = HEAD + 17, hy = HEAD + 36;
  const g0 = x.perf - 44, g1 = x.a11y;
  out.push(text((g0 + g1) / 2, gy, 'LIGHTHOUSE · MOBILE', { size: 10, color: 'd', anchor: 'middle', track: 0.16 }));
  out.push(rule(g0, g1, gy + 6, C.rule));
  const head = { size: 11, color: 'd', track: 0.16 };
  out.push(text(L, hy, 'PROJECT', head));
  out.push(text(x.live, hy, 'LIVE', head));
  out.push(text(x.perf, hy, 'PERF', { ...head, anchor: 'end' }));
  out.push(text(x.a11y, hy, 'A11Y', { ...head, anchor: 'end' }));
  out.push(text(x.tests, hy, 'TESTS', { ...head, anchor: 'end' }));
  out.push(text(x.push, hy, 'LAST PUSH', { ...head, anchor: 'end' }));
  out.push(star(x.stars - 6, hy - 4, 6, C.dim));
  out.push(rule(L, R, top - 1));

  // rows
  const num = (v, xr, y) => (v == null ? text(xr, y, DASH, { size: 18, color: 'd', anchor: 'end' }) : text(xr, y, String(v), { font: 'm7', size: 19, color: 'a', anchor: 'end' }));
  rows.forEach((p, i) => {
    const y0 = top + i * ROW, y = y0 + 30;
    const name = p.name.toUpperCase();
    out.push(text(L, y, name, { size: fit(name, 'b6', 20, x.live - L - 20, 0.05), track: 0.05 }));
    if (!p.live) {
      out.push(text(x.live, y, DASH, { size: 18, color: 'd' }));
    } else if (p.live.up) {
      out.push(dot(x.live + 4, y - 6.5, 4, true));
      out.push(text(x.live + 15, y, 'UP', { size: 16, track: 0.08 }));
      out.push(text(x.live + 104, y, String(p.live.ms), { font: 'm7', size: 19, color: 'a', anchor: 'end' }));
      out.push(text(x.live + 110, y, 'MS', { size: 11.5, color: 'd', track: 0.1 }));
    } else {
      out.push(dot(x.live + 4, y - 6.5, 4, false));
      out.push(text(x.live + 15, y, 'DOWN', { size: 16, track: 0.08 }));
      out.push(text(x.live + 62, y, p.live.reason, { size: 11.5, color: 'd', track: 0.1 }));
    }
    out.push(num(p.lighthouse?.perf, x.perf, y));
    out.push(num(p.lighthouse?.a11y, x.a11y, y));
    out.push(num(p.tested?.count, x.tests, y));
    if (p.tested?.flaky) out.push(text(x.tests + 1.5, y - 5, '*', { size: 15, color: 'd' }));
    if (p.tested) out.push(text(x.tests + 12, y, p.tested.day.board, { size: 11.5, color: 'd', track: 0.1 }));
    if (p.pushed) {
      out.push(text(x.push - 30, y, p.pushed.board, { font: 'm7', size: 19, color: 'a', anchor: 'end' }));
      out.push(text(x.push, y, 'AGO', { size: 11.5, color: 'd', anchor: 'end', track: 0.1 }));
    } else out.push(text(x.push, y, DASH, { size: 18, color: 'd', anchor: 'end' }));
    out.push(num(p.stars, x.stars, y));
    if (i < rows.length - 1) out.push(rule(L, R, y0 + ROW - 1, C.hair));
  });

  // footer
  const fy = top + rows.length * ROW;
  out.push(rule(L, R, fy));
  out.push(text(L, fy + 38, 'If it isn’t measured, it didn’t count.', { size: 18, track: 0.02 }));
  const flaky = rows.filter((p) => p.tested?.flaky);
  const note = flaky.length === 1
    ? `* ${flaky[0].name.toUpperCase()}: ${flaky[0].tested.flaky} OF ${flaky[0].tested.count} CHECKS ${flaky[0].tested.flaky === 1 ? 'IS' : 'ARE'} FLAKY`
    : flaky.length ? '* INCLUDES FLAKY CHECKS' : null;
  const small = { font: 'b5', size: 11, color: 'd', anchor: 'end', track: 0.16 };
  if (note) {
    out.push(text(R, fy + 29, 'MEASURED DAILY BY GITHUB ACTIONS', small));
    out.push(text(R, fy + 46, note, small));
  } else out.push(text(R, fy + 37, 'MEASURED DAILY BY GITHUB ACTIONS', small));

  const upCount = rows.filter((p) => p.live?.up).length;
  return svg(W, H, ['b6', 'b5', 'm7'], `Akinwale Dare, measured, as of ${stamp.text}`,
    `${upCount} of ${rows.length} live sites up. ` + rows.map(describe).join(' '), out);
}

function describe(p) {
  const live = !p.live ? 'live status not measured' : p.live.up ? `up, ${p.live.ms} ms` : `down, ${p.live.reason}`;
  const lh = p.lighthouse?.perf != null || p.lighthouse?.a11y != null ? `Lighthouse performance ${p.lighthouse.perf ?? 'not measured'}, accessibility ${p.lighthouse.a11y ?? 'not measured'}` : 'Lighthouse not measured';
  const tests = p.tested ? `${p.tested.count} tests on ${p.tested.day.text}${p.tested.flaky ? `, ${p.tested.flaky} of them flaky` : ''}` : 'no test count';
  return `${p.name}: ${live}; ${lh}; ${tests}; last push ${p.pushed?.text ?? 'unknown'}; ${p.stars ?? 'unknown'} stars.`;
}

function svg(w, h, fonts, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${style(new Set(fonts))}
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4" fill="${C.bg}" stroke="${C.rule}"/>
${body.join('\n')}
</svg>
`;
}

// ---------------------------------------------------------------- the per-project badge (380 x 48)

function badge(p, data) {
  const W = 380, H = 48, L = 14, R = W - 14;
  const out = [];
  const name = p.name.toUpperCase();
  out.push(text(L, 30, name, { size: fit(name, 'b6', 17, 96, 0.05, 12), track: 0.05 }));
  out.push(`<path d="M118.5 10V38" stroke="${C.rule}" stroke-width="1"/>`);
  const lab = { size: 9.5, color: 'd', track: 0.16 };
  const ly = 19, vy = 37;
  // live
  const lx = 130;
  out.push(text(lx, ly, 'LIVE', lab));
  if (!p.live) out.push(text(lx, vy, DASH, { size: 14, color: 'd' }));
  else if (p.live.up) {
    out.push(dot(lx + 3.5, vy - 4.75, 3.5, true));
    out.push(text(lx + 12, vy, 'UP', { size: 14, track: 0.06 }));
    out.push(text(lx + 32, vy, String(p.live.ms), { font: 'm7', size: 15, color: 'a' }));
    out.push(text(lx + 32 + width(String(p.live.ms), 'm7', 15) + 4, vy, 'MS', { size: 10, color: 'd', track: 0.1 }));
  } else {
    out.push(dot(lx + 3.5, vy - 4.75, 3.5, false));
    out.push(text(lx + 12, vy, 'DOWN', { size: 14, track: 0.06 }));
  }
  // lighthouse
  const hx = 224;
  out.push(text(hx, ly, 'LIGHTHOUSE', lab));
  const lh = p.lighthouse || {};
  const pv = lh.perf ?? DASH, av = lh.a11y ?? DASH;
  out.push(text(hx, vy, String(pv), { font: lh.perf == null ? 'b6' : 'm7', size: 15, color: lh.perf == null ? 'd' : 'a' }));
  const sep = hx + width(String(pv), lh.perf == null ? 'b6' : 'm7', 15) + 5;
  out.push(text(sep, vy, '·', { size: 14, color: 'd' }));
  out.push(text(sep + 9, vy, String(av), { font: lh.a11y == null ? 'b6' : 'm7', size: 15, color: lh.a11y == null ? 'd' : 'a' }));
  // tests
  const tx = 304;
  out.push(text(tx, ly, 'TESTS', lab));
  if (p.tested) {
    let cx = tx + width(String(p.tested.count), 'm7', 15);
    out.push(text(tx, vy, String(p.tested.count), { font: 'm7', size: 15, color: 'a' }));
    if (p.tested.flaky) { out.push(text(cx + 1, vy - 4, '*', { size: 12, color: 'd' })); cx += 5; }
    out.push(text(cx + 4, vy, p.tested.day.board, { size: 9.5, color: 'd', track: 0.08 }));
  } else out.push(text(tx, vy, DASH, { size: 14, color: 'd' }));
  void R;
  return svg(W, H, ['b6', 'm7'], `${p.name}, measured, as of ${asOf(data.at).text}`, describe(p), out);
}

// ---------------------------------------------------------------- README block

function readmeBlock(data) {
  const rows = view(data);
  const stamp = asOf(data.at).text;
  const up = rows.filter((p) => p.live?.up).length;
  const cell = (v) => (v == null ? DASH : String(v));
  const lines = [
    `<a href="${BOARD_URL}"><img src="measured/board.svg" width="840" alt="Measured scoreboard as of ${stamp}: ${up} of ${rows.length} live sites up. The same numbers are in the table below."></a>`,
    '',
    '<details>',
    '<summary>The same numbers as a table</summary>',
    '',
    `As of ${stamp}, measured ${data.runner === 'github-actions' ? 'by the daily GitHub Action' : 'by a local run of the same script'}: live status and response time (median of ${SAMPLES} fresh requests for each page's HTML), Lighthouse mobile performance and accessibility${data.lighthouse ? ` (${data.lighthouse})` : ' (not run this time)'}, and stars and last push from the GitHub API. Test counts come from running each project's suite and carry the date they ran. A dash means not measured.`,
    '',
    '| Project | Live | Lighthouse perf / a11y | Tests | Last push | Stars |',
    '|---|---|---|---|---|---|',
    ...rows.map((p) => {
      const live = !p.live ? DASH : p.live.up ? `Up · ${p.live.ms} ms` : `Down · ${p.live.reason}`;
      const lh = p.lighthouse?.perf == null && p.lighthouse?.a11y == null ? DASH : `${cell(p.lighthouse.perf)} / ${cell(p.lighthouse.a11y)}`;
      const tests = p.tested ? `${p.tested.count} on ${p.tested.day.text}: ${p.tested.suite}` : DASH;
      return `| [${p.name}](${p.url}) | ${live} | ${lh} | ${tests} | ${p.pushed?.text ?? DASH} | ${cell(p.stars)} |`;
    }),
    '',
    '</details>',
  ];
  return lines.join('\n');
}

function writeReadme(block) {
  const md = readFileSync(README, 'utf8');
  const re = /<!-- MEASURED:START -->[\s\S]*?<!-- MEASURED:END -->/;
  if (!re.test(md)) throw new Error('README.md is missing the <!-- MEASURED:START --> / <!-- MEASURED:END --> markers');
  writeFileSync(README, md.replace(re, () => `<!-- MEASURED:START -->\n${block}\n<!-- MEASURED:END -->`));
}

// ---------------------------------------------------------------- main

const data = argv.has('--render-only') ? JSON.parse(readFileSync(DATA, 'utf8')) : await measure();
if (!argv.has('--render-only')) writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(HERE, 'board.svg'), board(data));
for (const p of view(data)) writeFileSync(join(HERE, `${p.slug}.svg`), badge(p, data));
writeReadme(readmeBlock(data));
console.log(`rendered board.svg, ${config.projects.length} badges and the README block, as of ${asOf(data.at).text}`);

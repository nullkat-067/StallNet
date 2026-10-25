#!/usr/bin/env node
'use strict';

/*
 * Stall (StallNet) — a Node.js CLI to access PUBLIC GitHub repositories.
 * No npm dependencies. Node >= 18. Primary target: Termux (Android).
 *
 * Account: nullkat-067 (fixed, not configurable).
 *
 * Optional env:
 *   GITHUB_TOKEN        (or STALL_GITHUB_TOKEN) only to raise the rate limit.
 *                       The token is never stored or printed. Private repos are NEVER displayed.
 *   STALL_DIR           destination clone folder (default: current working directory)
 *   STALL_PAGE          repositories per menu page (default 5)
 *   STALL_TIMEOUT_MS    network request timeout (default 15000)
 *   DOCKER_HOST         used by the Test (sandbox) feature for a remote docker host, e.g. ssh://user@host
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.0.0';
const USER = 'nullkat-067'; // fixed GitHub account, not configurable
const API = (process.env.STALL_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const RAW = (process.env.STALL_RAW_URL || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
const TOKEN = process.env.STALL_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS) || 15000;
const PAGE_SIZE = Math.max(3, Number(process.env.STALL_PAGE) || 5);
const TTY = Boolean(process.stdout.isTTY);
const COLOR = TTY && !process.env.NO_COLOR;
const IS_TERMUX = Boolean(process.env.TERMUX_VERSION) || /com\.termux/.test(process.env.PREFIX || '');

// ───────────────────────── display utilities ─────────────────────────

const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = sgr('31');
const bred = sgr('1;91');
const white = sgr('97');
const bwhite = sgr('1;97');
const gray = sgr('90');
const errBadge = sgr('41;97');
const cols = () => Math.max(30, process.stdout.columns || 80);
const trunc = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
};
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const bar = (p, w = 20) => {
  const f = Math.round(Math.max(0, Math.min(1, p)) * w);
  return '[' + '█'.repeat(f) + '░'.repeat(w - f) + ']';
};

const lineOk = (m) => out(`  ${bwhite('[✓]')} ${white(m)}\n`);
const lineErr = (m) => out(`  ${errBadge('[✗]')} ${white(m)}\n`);
const lineInfo = (m) => out(`  ${red('[+]')} ${white(m)}\n`);
const lineWarn = (m) => out(`  ${bred('[!]')} ${white(m)}\n`);
const dim = (m) => out(`      ${gray(m)}\n`);

function clearScreen() {
  stopCredit();
  if (TTY) out('\x1b[2J\x1b[3J\x1b[H');
  else out('\n');
}
function hideCursor() { if (TTY) out('\x1b[?25l'); }
function showCursor() { if (TTY) out('\x1b[?25h'); }

function rule(title) {
  const side = red('─'.repeat(7));
  out(`\n  ${side} ${bwhite(title)} ${side}\n\n`);
}

const LOGO_BIG = [
  ['███████╗', '████████╗', ' █████╗ ', '██╗     ', '██╗     '],
  ['██╔════╝', '╚══██╔══╝', '██╔══██╗', '██║     ', '██║     '],
  ['███████╗', '   ██║   ', '███████║', '██║     ', '██║     '],
  ['╚════██║', '   ██║   ', '██╔══██║', '██║     ', '██║     '],
  ['███████║', '   ██║   ', '██║  ██║', '███████╗', '███████╗'],
  ['╚══════╝', '   ╚═╝   ', '╚═╝  ╚═╝', '╚══════╝', '╚══════╝'],
].map((r) => r.join(''));
const LOGO_SMALL = ['╔═╗╔╦╗╔═╗╦  ╦  ', '╚═╗ ║ ╠═╣║  ║  ', '╚═╝ ╩ ╩ ╩╩═╝╩═╝'];

// ── cursor position tracker: used by the credit animation to overwrite its own line without disturbing the prompt ──
const rawWrite = process.stdout.write.bind(process.stdout);
const trk = { on: false, rows: 0, col: 0 };
const TOKEN_RE = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b[78]|([\s\S])/g;
process.stdout.write = function (chunk, enc, cb) {
  if (trk.on) {
    const W = cols();
    const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(str))) {
      if (m[3] !== undefined) {
        const ch = m[3];
        if (ch === '\n') { trk.rows++; trk.col = 0; }
        else if (ch === '\r') trk.col = 0;
        else if (ch === '\b') trk.col = Math.max(0, trk.col - 1);
        else if (ch >= ' ') { trk.col++; if (trk.col > W) { trk.rows++; trk.col = 1; } }
      } else if (m[2]) {
        const n = parseInt(m[1], 10) || 1;
        if (m[2] === 'D') trk.col = Math.max(0, trk.col - n);
        else if (m[2] === 'C') trk.col += n;
        else if (m[2] === 'G') trk.col = n - 1;
        else if (m[2] === 'A') trk.rows = Math.max(0, trk.rows - n);
        else if (m[2] === 'B') trk.rows += n;
      }
    }
  }
  return rawWrite(chunk, enc, cb);
};

// ── credit "made by: NullKat": typed, held, erased letter-by-letter, repeated forever (colorful) ──
const CREDIT_NAME = 'NullKat';
const CREDIT_PREFIX = 'made by: ';
const RAINBOW = [196, 208, 226, 46, 51, 39, 129, 201];
const credit = { timer: null, pad: 0, idx: 0, phase: 'type', wait: 0, shift: 0 };

function creditLine() {
  const c = credit;
  let name = '';
  for (let i = 0; i < c.idx; i++) {
    name += COLOR ? `\x1b[1;38;5;${RAINBOW[(i + c.shift) % RAINBOW.length]}m${CREDIT_NAME[i]}\x1b[0m` : CREDIT_NAME[i];
  }
  const cursor = c.phase === 'hold' && c.shift % 2 ? ' ' : bwhite('▌');
  return '  ' + ' '.repeat(c.pad) + gray(CREDIT_PREFIX) + name + cursor;
}
function creditTick() {
  const c = credit;
  c.shift++;
  if (c.phase === 'type') { c.idx++; if (c.idx >= CREDIT_NAME.length) { c.phase = 'hold'; c.wait = 14; } }
  else if (c.phase === 'hold') { if (--c.wait <= 0) c.phase = 'del'; }
  else if (c.phase === 'del') { c.idx--; if (c.idx <= 0) { c.idx = 0; c.phase = 'gap'; c.wait = 4; } }
  else if (--c.wait <= 0) c.phase = 'type';
  const up = trk.rows + 1;
  if (up >= (process.stdout.rows || 24)) return; // the credit line has scrolled off-screen
  rawWrite(`\x1b7\x1b[${up}A\r\x1b[2K${creditLine()}\x1b8`);
}
function stopCredit() {
  if (credit.timer) { clearInterval(credit.timer); credit.timer = null; }
  trk.on = false;
}
/** Print the credit line then start its animation (TTY only). Called right after the logo. */
function creditStart(pad) {
  stopCredit();
  if (!TTY) { out('  ' + ' '.repeat(pad) + gray(CREDIT_PREFIX) + bwhite(CREDIT_NAME) + '\n'); return; }
  Object.assign(credit, { pad, idx: 0, phase: 'type', wait: 0, shift: 0 });
  out('  ' + ' '.repeat(pad) + gray(CREDIT_PREFIX) + '\n');
  trk.rows = 0; trk.col = 0; trk.on = true;
  credit.timer = setInterval(creditTick, 100);
}

const BRAND_LABEL = 'Net';
async function banner(animate) {
  const logo = cols() >= 46 ? LOGO_BIG : LOGO_SMALL;
  const w = logo[0].length;
  out('\n');
  for (const l of logo) {
    out('  ' + bred(l) + '\n');
    if (animate && TTY) await sleep(35);
  }
  out('  ' + ' '.repeat(Math.max(0, Math.floor((w - BRAND_LABEL.length) / 2))));
  if (animate && TTY) {
    for (const ch of BRAND_LABEL) { out(bwhite(ch)); await sleep(90); }
  } else out(bwhite(BRAND_LABEL));
  out('\n');
  creditStart(Math.max(0, Math.floor((w - (CREDIT_PREFIX.length + CREDIT_NAME.length)) / 2)));
  out('  ' + gray('─'.repeat(Math.min(w, cols() - 4))) + '\n');
}

function header() {
  const logo = cols() >= 46 ? LOGO_BIG : LOGO_SMALL;
  const w = logo[0].length;
  out('\n');
  for (const l of logo) out('  ' + bred(l) + '\n');
  out('  ' + ' '.repeat(Math.max(0, Math.floor((w - BRAND_LABEL.length) / 2))) + bwhite(BRAND_LABEL) + '\n');
  creditStart(Math.max(0, Math.floor((w - (CREDIT_PREFIX.length + CREDIT_NAME.length)) / 2)));
  out('  ' + gray('─'.repeat(Math.min(w, cols() - 4))) + '\n');
}

async function blink(times = 3) {
  if (!TTY) return;
  for (let i = 0; i < times; i++) {
    out('\r  ' + bred('█'));
    await sleep(160);
    out('\r  ' + ' ');
    await sleep(160);
  }
  out('\r\x1b[2K');
}

// ───────────────────────── errors & process ─────────────────────────

class StallError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    if (extra) Object.assign(this, extra);
  }
}

let rl = null;
let closed = false;
let waiter = null;
const queue = [];
let activeCancel = null;
let intrCount = 0;
const children = new Set();

function cleanup() {
  stopCredit();
  showCursor();
  if (COLOR) out('\x1b[0m');
  for (const c of children) { try { c.kill('SIGKILL'); } catch (_) { /* ignore */ } }
  try { if (rl) rl.close(); } catch (_) { /* ignore */ }
}
function shutdown(code = 0) {
  cleanup();
  out('\n  ' + gray('Stall closed.') + '\n');
  process.exit(code);
}
function onInterrupt() {
  intrCount++;
  if (activeCancel && intrCount < 3) { activeCancel(); return; }
  shutdown(130);
}
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', () => shutdown(143));
process.on('exit', () => { if (TTY) process.stdout.write('\x1b[?25h\x1b[0m'); });
process.on('uncaughtException', (e) => { cleanup(); console.error('\n  Unexpected error:', redact(e && e.stack ? e.stack : e)); process.exit(1); });
process.on('unhandledRejection', (e) => { cleanup(); console.error('\n  Unexpected error:', redact(e && e.stack ? e.stack : e)); process.exit(1); });

function initInput() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && TTY) });
  rl.on('line', (l) => {
    if (waiter) { const w = waiter; waiter = null; w(l.trim()); }
    else if (!process.stdin.isTTY) queue.push(l);
  });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  rl.on('SIGINT', onInterrupt);
}

function ask(prompt) {
  return new Promise((resolve) => {
    if (queue.length) { const l = queue.shift(); out(prompt + l + '\n'); return resolve(l.trim()); }
    if (closed) return resolve(null);
    waiter = resolve;
    showCursor();
    rl.setPrompt(prompt);
    rl.prompt();
  });
}
async function pause() {
  const a = await ask(gray('\n  Press Enter to go back '));
  if (a === null) shutdown(0);
}

function commandExists(cmd) {
  return spawnSync('sh', ['-c', 'command -v "$0"', cmd], { stdio: 'ignore' }).status === 0;
}

/** Run a process with streaming line output. Resolves to {code, killed, tail}. */
function runProc(cmd, args, opts = {}) {
  const { signal, env, cwd, onLine, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new StallError('spawn', `Failed to run ${cmd}: ${e.message}`));
    }
    children.add(child);
    const bufs = { o: '', e: '' };
    const tail = [];
    const emit = (l, k) => {
      if (!l.trim()) return;
      tail.push(l);
      if (tail.length > 40) tail.shift();
      if (onLine) onLine(l, k);
    };
    const feed = (k, chunk) => {
      bufs[k] += chunk.toString('utf8');
      const parts = bufs[k].split(/[\r\n]+/);
      bufs[k] = parts.pop();
      parts.forEach((l) => emit(l, k));
    };
    child.stdout.on('data', (d) => feed('o', d));
    child.stderr.on('data', (d) => feed('e', d));
    let killed = null;
    const kill = (why) => {
      killed = why;
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 3000).unref();
    };
    const onAbort = () => kill('cancel');
    if (signal) {
      if (signal.aborted) kill('cancel');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const to = timeoutMs ? setTimeout(() => kill('timeout'), timeoutMs) : null;
    const done = () => {
      if (to) clearTimeout(to);
      if (signal) signal.removeEventListener('abort', onAbort);
      children.delete(child);
    };
    child.on('error', (e) => {
      done();
      reject(new StallError('spawn', e.code === 'ENOENT' ? `Command not found: ${cmd}` : e.message));
    });
    child.on('close', (code) => {
      emit(bufs.o, 'o');
      emit(bufs.e, 'e');
      done();
      resolve({ code, killed, tail });
    });
  });
}

/**
 * Run real work with a spinner + progress bar.
 * Percentage is only shown when fn calls ctx.progress(p) with a real value.
 */
async function task(label, fn) {
  const ctl = new AbortController();
  const st = { p: null, note: '' };
  const ctx = {
    signal: ctl.signal,
    progress(p, note) {
      if (p != null) st.p = Math.max(0, Math.min(1, p));
      if (note !== undefined) st.note = note;
    },
    log(line) {
      if (TTY) out('\r\x1b[2K');
      out(`      ${gray(trunc(line, cols() - 8))}\n`);
    },
  };
  const t0 = Date.now();
  const prevCancel = activeCancel;
  const prevCount = intrCount;
  intrCount = 0;
  activeCancel = () => ctl.abort();
  let frame = 0;
  let timer = null;
  const render = () => {
    const dots = '.'.repeat(1 + (Math.floor(frame / 4) % 3)).padEnd(3);
    let line = `  ${red(SPIN[frame++ % SPIN.length])} ${white(label)}${gray(dots)}`;
    let used = 2 + 1 + 1 + label.length + 3;
    if (st.p != null) {
      line += ` ${red(bar(st.p, 16))} ${white(String(Math.round(st.p * 100)).padStart(3) + '%')}`;
      used += 1 + 18 + 1 + 4;
    }
    const room = cols() - used - 2;
    if (st.note && room > 8) line += ' ' + gray(trunc(st.note, room));
    out('\r\x1b[2K' + line);
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; if (TTY) out('\r\x1b[2K'); };
  try {
    if (TTY) { hideCursor(); render(); timer = setInterval(render, 80); }
    else out(`  [+] ${label}...\n`);
    const r = await fn(ctx);
    if (TTY) { const el = Date.now() - t0; if (el < 250) await sleep(250 - el); }
    stop();
    lineOk(`${label} ${gray('(' + ((Date.now() - t0) / 1000).toFixed(1) + 's)')}`);
    return r;
  } catch (e) {
    stop();
    const err = ctl.signal.aborted ? new StallError('cancel', 'Cancelled by user') : e;
    lineErr(`${label} ${gray('— failed')}`);
    throw err;
  } finally {
    stop();
    activeCancel = prevCancel;
    intrCount = prevCount;
    showCursor();
  }
}

function showError(e) {
  const msg = redact(e && e.message ? e.message : e);
  out(`\n  ${errBadge(' ERR ')} ${white(msg)}\n`);
  if (e && e.hint) dim(e.hint);
  if (e && Array.isArray(e.detail) && e.detail.length) {
    out('\n');
    e.detail.slice(-8).forEach((l) => dim(trunc(redact(l), cols() - 8)));
  }
}

// ───────────────────────── HTTP & GitHub ─────────────────────────

const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return String(u); } };

async function request(url, { signal, headers = {}, maxBytes = 2000000 } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new StallError('cancel', 'Cancelled by user'); }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `StallNet/${VERSION}`, ...headers }, signal: ctl.signal, redirect: 'follow' });
    let text = await res.text();
    if (text.length > maxBytes) text = text.slice(0, maxBytes);
    return { status: res.status, headers: res.headers, text, url: res.url };
  } catch (e) {
    if (signal && signal.aborted) throw new StallError('cancel', 'Cancelled by user');
    if (timedOut) throw new StallError('timeout', `Timed out after ${TIMEOUT_MS / 1000}s while contacting ${hostOf(url)}`, { hint: 'Slow or dropped connection. Try again.' });
    const code = e && e.cause && e.cause.code;
    throw new StallError('network', `Cannot reach ${hostOf(url)}${code ? ` (${code})` : ''}`, { hint: 'Check your internet connection / DNS, then try again.' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function ghJson(p, ctx) {
  const url = p.startsWith('http') ? p : API + p;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN && url.startsWith(API)) headers.Authorization = `Bearer ${TOKEN}`; // token is never sent to any other host
  const r = await request(url, { signal: ctx && ctx.signal, headers });
  if (r.status === 401) {
    throw new StallError('auth', 'Authentication failed: GitHub token rejected (invalid / expired).', { hint: 'Refresh GITHUB_TOKEN, or unset it (the token is optional).' });
  }
  if (r.status === 403 || r.status === 429) {
    const remaining = r.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || r.status === 429 || /rate limit/i.test(r.text)) {
      const reset = Number(r.headers.get('x-ratelimit-reset'));
      const retry = Number(r.headers.get('retry-after'));
      let when = '';
      if (reset) when = ` Reset around ${new Date(reset * 1000).toLocaleTimeString()} (${Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000))} minutes from now).`;
      else if (retry) when = ` Retry in ${retry} seconds.`;
      throw new StallError('ratelimit', `GitHub API rate limit reached.${when}`, { hint: TOKEN ? '' : 'Set GITHUB_TOKEN (no scope needed) for a higher limit.' });
    }
    throw new StallError('auth', 'Access denied by GitHub (403).');
  }
  if (r.status === 404) throw new StallError('notfound', 'Not found on GitHub (404). Check the username / repository name.');
  if (r.status < 200 || r.status >= 300) throw new StallError('http', `GitHub API responded HTTP ${r.status}.`);
  let json;
  try { json = JSON.parse(r.text); } catch (_) { throw new StallError('http', 'GitHub response is not valid JSON.'); }
  return { json, link: r.headers.get('link') || '' };
}

function nextLink(link) {
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link || '');
  if (!m) return null;
  return m[1].startsWith(API) ? m[1] : null; // only follow links back to the same API host
}

const slim = (r) => ({
  name: r.name,
  full_name: r.full_name,
  owner: r.owner && r.owner.login,
  description: r.description || '',
  html_url: r.html_url,
  clone_url: r.clone_url,
  default_branch: r.default_branch || 'main',
  language: r.language || '',
  stars: r.stargazers_count || 0,
  forks: r.forks_count || 0,
  size: r.size || 0,
  fork: Boolean(r.fork),
  archived: Boolean(r.archived),
  pushed_at: r.pushed_at || r.updated_at || '',
  homepage: r.homepage || '',
  has_pages: Boolean(r.has_pages),
});

async function connect(state, ctx) {
  const u = await ghJson(`/users/${encodeURIComponent(USER)}`, ctx);
  state.total = typeof u.json.public_repos === 'number' ? u.json.public_repos : null;
  state.login = u.json.login || USER;
}

async function fetchRepos(state, ctx) {
  const all = [];
  let pages = 0;
  let next = `/users/${encodeURIComponent(state.login)}/repos?type=owner&sort=pushed&direction=desc&per_page=100`;
  ctx.progress(state.total === 0 ? 1 : 0, 'contacting API');
  while (next) {
    const { json, link } = await ghJson(next, ctx);
    if (!Array.isArray(json)) throw new StallError('http', 'Unknown repository list format.');
    all.push(...json);
    pages++;
    ctx.progress(state.total ? all.length / state.total : null, `page ${pages} · ${all.length} repos`);
    next = nextLink(link);
  }
  ctx.progress(1);
  // Public repos only, whatever the API may return.
  return all.filter((r) => r && r.private === false && !r.disabled).map(slim);
}

async function loadRepos(state) {
  for (;;) {
    try {
      await task('Connecting to GitHub', (ctx) => connect(state, ctx));
      const repos = await task('Fetching repositories', (ctx) => fetchRepos(state, ctx));
      state.repos = repos;
      out(`\n  ${red(bar(1, 20))} ${white('100%')}\n\n`);
      out(`  ${bwhite(`Found ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}.`)} ${gray(`(@${USER}, public only)`)}\n`);
      if (repos.length > 0) return;
      lineWarn('No public repositories. Private repositories are intentionally not shown.');
    } catch (e) {
      showError(e);
    }
    out(`\n  ${red('[r]')} Retry   ${red('[q]')} Quit\n`);
    const a = await ask(`  ${bwhite('Choose')} ${red('>')} `);
    if (a === null || a.toLowerCase() === 'q') shutdown(0);
  }
}

// ───────────────────────── repo list menu ─────────────────────────

const fmtDate = (s) => (s ? String(s).slice(0, 10) : '-');

async function listLoop(state) {
  let page = 0;
  let filter = '';
  let notice = '';
  for (;;) {
    const f = filter.toLowerCase();
    const view = state.repos.filter((r) => !f || `${r.name} ${r.description} ${r.language}`.toLowerCase().includes(f));
    const pages = Math.max(1, Math.ceil(view.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);
    clearScreen();
    header();
    rule('PROJECTS');
    if (view.length === 0) out(`  ${gray('No results for filter "' + filter + '".')}\n`);
    const start = page * PAGE_SIZE;
    view.slice(start, start + PAGE_SIZE).forEach((r, i) => {
      const n = start + i + 1;
      const tags = [r.fork ? 'fork' : '', r.archived ? 'archived' : '', r.size === 0 ? 'empty' : ''].filter(Boolean).map((t) => `[${t}]`).join('');
      out(`  ${red('[' + n + ']')} ${bwhite(r.name)} ${gray(tags)}\n`);
      const meta = [r.language, r.stars ? `★${r.stars}` : '', r.description].filter(Boolean).join(' · ');
      if (meta) out(`      ${gray(trunc(meta, cols() - 8))}\n`);
    });
    out(`\n  ${gray(`Page ${page + 1}/${pages} · ${view.length} repos${filter ? ` · filter: ${filter}` : ''}`)}\n`);
    out(`  ${gray('[n] next  [p] prev  [r] refresh')}\n`);
    out(`  ${gray('[/text] search  [q] quit')}\n`);
    if (notice) { lineWarn(notice); notice = ''; }
    const a = await ask(`\n  ${bwhite('Select project')} ${red('>')} `);
    if (a === null) shutdown(0);
    const lc = a.toLowerCase();
    if (lc === 'q') shutdown(0);
    else if (lc === 'n') page++;
    else if (lc === 'p') page--;
    else if (lc === 'r') { clearScreen(); header(); out('\n'); await loadRepos(state); page = 0; await pause(); }
    else if (a.startsWith('/')) { filter = a.slice(1).trim(); page = 0; }
    else if (/^\d+$/.test(a)) {
      const idx = Number(a);
      if (idx >= 1 && idx <= view.length) await repoMenu(view[idx - 1]);
      else notice = `Number out of range (1-${view.length}).`;
    } else if (a !== '') notice = 'Unrecognized input.';
  }
}

async function repoMenu(repo) {
  for (;;) {
    clearScreen();
    header();
    rule(trunc(repo.name, cols() - 24).toUpperCase());
    if (repo.description) out(`  ${white(trunc(repo.description, cols() * 2 - 8))}\n`);
    out(`  ${gray(`${repo.html_url}`)}\n`);
    out(`  ${gray(trunc(`${repo.default_branch} · ${repo.language || '?'} · ★${repo.stars} · ${fmtDate(repo.pushed_at)}${repo.size === 0 ? ' · EMPTY' : ''}`, cols() - 4))}\n\n`);
    out(`  ${red('[1]')} ${bwhite('Install')}\n`);
    out(`  ${red('[2]')} ${bwhite('Redirect to Repository')}\n`);
    out(`  ${red('[3]')} ${bwhite('Test')}\n\n`);
    out(`  ${gray('[0] Back   [q] Quit')}\n`);
    const a = await ask(`\n  ${bwhite('Choose')} ${red('>')} `);
    if (a === null) shutdown(0);
    const lc = a.toLowerCase();
    if (lc === '0' || lc === 'b') return;
    if (lc === 'q') shutdown(0);
    if (a === '1') { await installRepo(repo); await pause(); }
    else if (a === '2') { await redirectRepo(repo); await pause(); }
    else if (a === '3') { await testRepo(repo); await pause(); }
    else if (a !== '') { lineWarn('Choose 1, 2, 3, or 0 to go back.'); await sleep(TTY ? 900 : 0); }
  }
}

// ───────────────────────── [1] Install ─────────────────────────

function pathTaken(p) {
  try { fs.lstatSync(p); return true; } catch (_) { return false; }
}

async function installRepo(repo) {
  rule('INSTALL');
  if (!commandExists('git')) {
    lineErr('git not found.');
    dim(IS_TERMUX ? 'Termux: pkg install git' : 'Install git first.');
    return;
  }
  const base = path.resolve(process.env.STALL_DIR || process.cwd());
  let dest = path.join(base, repo.name);
  while (pathTaken(dest)) {
    lineWarn(`Folder already exists: ${dest}`);
    dim('Its contents will not be overwritten.');
    const a = await ask(`  ${bwhite('Different folder name')} ${gray('(empty = cancel)')} ${red('>')} `);
    if (!a) { lineInfo('Install cancelled.'); return; }
    if (!/^[\w][\w.-]*$/.test(a)) { lineWarn('Invalid folder name (letters, digits, _ . - only).'); continue; }
    dest = path.join(base, a);
  }
  if (repo.size === 0) lineWarn('This repository is empty; cloning will produce an empty folder.');
  lineInfo(`Destination: ${dest}`);
  try {
    await task('Cloning repository', async (ctx) => {
      const r = await runProc('git', ['clone', '--progress', '--', repo.clone_url, dest], {
        signal: ctx.signal,
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 15 * 60 * 1000,
        onLine: (l) => {
          const m = /(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/.exec(l);
          if (m) {
            const pct = Number(m[2]) / 100;
            const map = { 'Counting objects': [0, 0.05], 'Compressing objects': [0.05, 0.1], 'Receiving objects': [0.1, 0.8], 'Resolving deltas': [0.8, 0.95], 'Updating files': [0.95, 1] };
            const [a, b] = map[m[1]];
            ctx.progress(a + (b - a) * pct, m[1].toLowerCase());
          } else ctx.log(l);
        },
      });
      if (r.killed === 'cancel') throw new StallError('cancel', 'Cancelled by user');
      if (r.killed === 'timeout') throw new StallError('timeout', 'git clone exceeded the 15 minute limit.');
      if (r.code !== 0) throw new StallError('git', `git clone failed (exit ${r.code}).`, { detail: r.tail });
    });
    lineOk(`Done: ${dest}`);
    dim(`Next:  cd "${dest}"`);
  } catch (e) {
    // this folder did not exist before the clone, so it is safe to clean up if the clone failed / was cancelled
    try { if (pathTaken(dest)) fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    showError(e);
  }
}

// ───────────────────────── [2] Redirect ─────────────────────────

function openUrl(url) {
  const cands = [['termux-open-url', [url]], ['xdg-open', [url]], ['open', [url]]];
  for (const [cmd, args] of cands) {
    if (commandExists(cmd) && spawnSync(cmd, args, { stdio: 'ignore', timeout: 8000 }).status === 0) return cmd;
  }
  if (IS_TERMUX && commandExists('am')) {
    const r = spawnSync('am', ['start', '-a', 'android.intent.action.VIEW', '-d', url], { stdio: 'ignore', timeout: 8000 });
    if (r.status === 0) return 'am';
  }
  return null;
}

async function redirectRepo(repo) {
  rule('REDIRECT');
  const how = openUrl(repo.html_url);
  if (how) lineOk(`Browser opener command executed (${how}).`);
  else {
    lineWarn('Cannot open a browser from here.');
    dim(IS_TERMUX ? 'Termux: pkg install termux-tools  (provides termux-open-url)' : 'No URL opener available.');
  }
  out(`\n  ${white('URL:')} ${bwhite(repo.html_url)}\n`);
}

// ───────────────────────── [3] Test ─────────────────────────

const EXT_LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', php: 'PHP', java: 'Java', kt: 'Kotlin', rb: 'Ruby', c: 'C', h: 'C', cpp: 'C++', cs: 'C#', dart: 'Dart', html: 'HTML', css: 'CSS', sh: 'Shell', vue: 'Vue', svelte: 'Svelte' };

function topLangs(files) {
  const count = {};
  for (const f of files) {
    if (/(^|\/)(node_modules|vendor|dist|build)\//.test(f)) continue;
    const l = EXT_LANG[(f.split('.').pop() || '').toLowerCase()];
    if (l) count[l] = (count[l] || 0) + 1;
  }
  const total = Object.values(count).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, n]) => `${l} ${Math.round((n / total) * 100)}%`);
}

async function rawText(repo, p, ctx) {
  const url = `${RAW}/${repo.full_name}/${encodeURIComponent(repo.default_branch)}/${p.split('/').map(encodeURIComponent).join('/')}`;
  const r = await request(url, { signal: ctx.signal, maxBytes: 300000 });
  return r.status === 200 ? r.text : null;
}

const WEB_DEPS = ['next', 'vite', 'react-scripts', 'react', 'vue', 'svelte', '@sveltejs/kit', 'astro', '@angular/core', 'parcel', 'webpack', 'nuxt'];
const API_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi', 'restify'];
const DB_DEPS = ['mongoose', 'mongodb', 'pg', 'mysql', 'mysql2', 'sequelize', 'prisma', '@prisma/client', 'redis', 'ioredis', 'typeorm', 'sqlite3'];
const safeRel = (p) => typeof p === 'string' && /^[\w./@-]+$/.test(p) && !p.includes('..');

async function analyze(repo, ctx) {
  ctx.progress(0.1, 'reading file structure');
  const tr = await ghJson(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`, ctx).catch((e) => {
    if (e.kind === 'http' || e.kind === 'notfound') return { json: { tree: [] } }; // empty repo
    throw e;
  });
  const files = (tr.json.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
  const has = (p) => files.includes(p);
  const info = { files, truncated: Boolean(tr.json.truncated), kind: 'unknown', runtime: '', langs: topLangs(files), deps: [], devDeps: 0, entry: '', scripts: [], notes: [], plan: null, previewable: false, pkg: null, staticIssues: null };

  if (files.length === 0) { info.notes.push('Repository is empty or its structure cannot be read.'); return info; }
  if (has('.env.example') || has('.env.sample')) info.notes.push('.env.example found → environment configuration required.');
  if (has('docker-compose.yml') || has('docker-compose.yaml')) info.notes.push('docker-compose found → likely requires external services.');

  if (has('package.json')) {
    ctx.progress(0.4, 'reading package.json');
    const txt = await rawText(repo, 'package.json', ctx);
    let pkg = null;
    try { pkg = JSON.parse(txt); } catch (_) { info.notes.push('package.json cannot be parsed.'); }
    if (pkg) {
      info.runtime = 'Node.js';
      info.pkg = pkg;
      const deps = Object.keys(pkg.dependencies || {});
      const dev = Object.keys(pkg.devDependencies || {});
      const all = deps.concat(dev);
      info.deps = deps;
      info.devDeps = dev.length;
      info.scripts = Object.keys(pkg.scripts || {});
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
      info.entry = bin || pkg.main || (has('index.js') ? 'index.js' : '');
      const isWeb = all.some((d) => WEB_DEPS.includes(d));
      const isApi = all.some((d) => API_DEPS.includes(d));
      if (bin) info.kind = 'cli';
      else if (isWeb && isApi) info.kind = 'fullstack';
      else if (isWeb) info.kind = 'web';
      else if (isApi) info.kind = 'api';
      else info.kind = 'node';
      const dbs = all.filter((d) => DB_DEPS.includes(d));
      if (dbs.length) info.notes.push(`Uses database/services (${dbs.join(', ')}) → may need an external server.`);
      info.previewable = true;
    }
  } else if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) {
    info.runtime = 'Python';
    const req = has('requirements.txt') ? (await rawText(repo, 'requirements.txt', ctx)) || '' : '';
    const names = req.split(/\r?\n/).map((l) => l.trim().toLowerCase().split(/[<>=!~\[; ]/)[0]).filter(Boolean);
    info.deps = names;
    info.kind = names.some((n) => ['flask', 'fastapi', 'django', 'aiohttp', 'sanic'].includes(n)) ? 'api' : 'python';
    info.entry = ['main.py', 'app.py', 'run.py', 'manage.py', '__main__.py'].find(has) || '';
  } else if (has('go.mod')) { info.runtime = 'Go'; info.kind = 'go'; info.entry = ['main.go', 'cmd'].find((p) => has(p) || files.some((f) => f.startsWith(p + '/'))) || ''; }
  else if (has('Cargo.toml')) { info.runtime = 'Rust'; info.kind = 'rust'; info.entry = has('src/main.rs') ? 'src/main.rs' : 'src/lib.rs'; }
  else if (has('composer.json')) { info.runtime = 'PHP'; info.kind = 'php'; }
  else if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) { info.runtime = 'JVM'; info.kind = 'jvm'; }
  else if (has('index.html')) {
    info.runtime = 'Browser'; info.kind = 'static-web'; info.entry = 'index.html'; info.previewable = true;
  }

  if (info.kind === 'static-web') {
    ctx.progress(0.7, 'checking index.html assets');
    const html = await rawText(repo, 'index.html', ctx);
    if (html) {
      const missing = [];
      const re = /(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        const ref = m[1].trim();
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) || !ref) continue;
        const norm = path.posix.normalize(ref.startsWith('/') ? ref.slice(1) : ref);
        if (norm.endsWith('/') || norm === '.' || norm.startsWith('..')) continue;
        if (!has(norm) && !missing.includes(norm)) missing.push(norm);
      }
      info.staticIssues = { title: (/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || '', missing };
    }
  }

  info.plan = buildPlan(info, files);
  ctx.progress(1);
  return info;
}

function buildPlan(info, files) {
  const steps = [];
  const anyFile = (re) => files.some((f) => re.test(f));
  if (info.runtime === 'Node.js' && info.pkg) {
    const s = (info.pkg && info.pkg.scripts) || {};
    steps.push({ label: 'npm install', cmd: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' });
    const realTest = s.test && !/no test specified/i.test(s.test);
    const bin = typeof info.pkg.bin === 'string' ? info.pkg.bin : Object.values(info.pkg.bin || {})[0];
    let built = false;
    if (realTest) steps.push({ label: 'npm test', cmd: 'npm test' });
    else if (info.kind === 'cli' && safeRel(bin)) steps.push({ label: `node ${bin} --help`, cmd: `timeout 20 node ${bin} --help </dev/null` });
    else if (s.build) { steps.push({ label: 'npm run build', cmd: 'npm run build' }); built = true; }
    if (!built && s.build && (info.kind === 'web' || info.kind === 'fullstack')) steps.push({ label: 'npm run build', cmd: 'npm run build' });
    if ((info.kind === 'api' || info.kind === 'fullstack') && s.start) {
      steps.push({
        label: 'npm start + HTTP check (port 3000)',
        cmd: [
          'PORT=3000 npm start >/tmp/stall-server.log 2>&1 &',
          'SRV=$!',
          'code=000',
          'for i in $(seq 1 25); do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ || true); [ "$code" != "000" ] && break; sleep 1; done',
          'echo "HTTP $code"',
          'tail -n 15 /tmp/stall-server.log || true',
          'kill $SRV 2>/dev/null || true',
          '[ "$code" != "000" ]',
        ].join('\n'),
      });
    }
    return { image: 'node:20-bookworm', env: {}, steps };
  }
  if (info.runtime === 'Python') {
    if (info.files.includes('requirements.txt')) steps.push({ label: 'pip install -r requirements.txt', cmd: 'pip install --user --no-cache-dir -r requirements.txt' });
    else steps.push({ label: 'pip install .', cmd: 'pip install --user --no-cache-dir .' });
    if (anyFile(/(^|\/)(tests?\/|test_[^/]*\.py$|[^/]*_test\.py$)/)) {
      steps.push({ label: 'pytest', cmd: 'pip install --user --no-cache-dir pytest && python -m pytest -q' });
    } else steps.push({ label: 'python -m compileall', cmd: 'python -m compileall -q .' });
    return { image: 'python:3.12-bookworm', env: {}, steps };
  }
  if (info.kind === 'go') {
    steps.push({ label: 'go build ./...', cmd: 'go build ./...' });
    if (anyFile(/_test\.go$/)) steps.push({ label: 'go test ./...', cmd: 'go test ./...' });
    return { image: 'golang:1.22-bookworm', env: { GOFLAGS: '-buildvcs=false' }, steps };
  }
  if (info.kind === 'rust') {
    steps.push({ label: 'cargo check', cmd: 'cargo check' });
    return { image: 'rust:1-bookworm', env: { CARGO_HOME: '/tmp/cargo' }, steps };
  }
  return null;
}

function liveUrl(repo) {
  if (/^https?:\/\//i.test(repo.homepage)) return repo.homepage;
  if (repo.has_pages) {
    const o = (repo.owner || '').toLowerCase();
    return repo.name.toLowerCase() === `${o}.github.io` ? `https://${repo.name.toLowerCase()}/` : `https://${o}.github.io/${repo.name}/`;
  }
  return '';
}

function printReport(repo, info) {
  rule('ANALYSIS');
  const row = (k, v) => out(`  ${gray(k.padEnd(11))} ${white(trunc(v, cols() - 16))}\n`);
  const kinds = { cli: 'CLI', api: 'API / server', web: 'Website (frontend)', fullstack: 'Full-stack web', node: 'Node.js project', python: 'Python project', go: 'Go project', rust: 'Rust project', php: 'PHP project', jvm: 'Java/Kotlin project', 'static-web': 'Static website', unknown: 'Unknown' };
  row('Type', kinds[info.kind] || info.kind);
  if (info.runtime) row('Runtime', info.runtime);
  if (info.langs.length) row('Language', info.langs.join(', '));
  if (info.entry) row('Entry point', info.entry);
  if (info.pkg || info.deps.length) row('Dependencies', `${info.deps.length}${info.pkg ? ` prod / ${info.devDeps} dev` : ''}${info.deps.length ? ' (' + info.deps.slice(0, 4).join(', ') + (info.deps.length > 4 ? ', …' : '') + ')' : ''}`);
  if (info.scripts.length) row('Scripts', info.scripts.slice(0, 8).join(', '));
  if (info.truncated) info.notes.push('File list truncated (very large repo); analysis may be incomplete.');
  info.notes.forEach((n) => out(`  ${bred('!')} ${gray(trunc(n, cols() - 6))}\n`));
  if (info.staticIssues) {
    const s = info.staticIssues;
    out('\n');
    if (s.title) lineOk(`index.html: title "${trunc(s.title, 30)}"`); else lineWarn('index.html has no <title>.');
    if (s.missing.length === 0) lineOk('All referenced local assets exist in the repository.');
    else { lineErr(`${s.missing.length} local assets not found in the repository:`); s.missing.slice(0, 6).forEach((m) => dim(m)); }
  }
}

async function probeUrl(url, ctx) {
  ctx.progress(null, hostOf(url));
  const t0 = Date.now();
  const r = await request(url, { signal: ctx.signal, maxBytes: 500000 });
  return { status: r.status, ms: Date.now() - t0, type: r.headers.get('content-type') || '-', bytes: r.text.length, title: ((/<title[^>]*>([^<]*)/i.exec(r.text) || [])[1] || '').trim(), finalUrl: r.url };
}

function dockerReady() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0 && Boolean((r.stdout || '').trim());
}

async function sandboxRun(repo, plan) {
  const name = 'stall-' + Date.now().toString(36);
  const script = ['set -e', 'git clone --depth 1 --branch "$STALL_BRANCH" -- "$STALL_URL" /work/app', 'cd /work/app']
    .concat(plan.steps.flatMap((s) => [`echo ">> ${s.label}"`, s.cmd])).join('\n');
  const envArgs = Object.entries({ HOME: '/tmp', CI: 'true', STALL_URL: repo.clone_url, STALL_BRANCH: repo.default_branch, ...plan.env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const args = ['run', '--rm', '--name', name, '--cpus', '1', '--memory', '768m', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    '--tmpfs', '/work:rw,exec,nosuid,size=1g,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m,uid=1000,gid=1000', ...envArgs, '-w', '/work', plan.image, 'sh', '-c', script];
  let lastStep = '(clone)';
  let result;
  try {
    result = await task('Running tests in sandbox', async (ctx) => {
      ctx.progress(null, plan.image);
      const r = await runProc('docker', args, {
        signal: ctx.signal,
        timeoutMs: 6 * 60 * 1000,
        onLine: (l) => {
          if (l.startsWith('>> ')) { lastStep = l.slice(3); ctx.progress(null, lastStep); }
          ctx.log(l);
        },
      });
      if (r.killed) { spawnSync('docker', ['kill', name], { stdio: 'ignore', timeout: 8000 }); }
      if (r.killed === 'cancel') throw new StallError('cancel', 'Cancelled by user');
      if (r.killed === 'timeout') throw new StallError('timeout', `Sandbox exceeded the 6 minute limit at step: ${lastStep}`);
      return r;
    });
  } catch (e) {
    showError(e);
    return;
  }
  out('\n');
  if (result.code === 0) lineOk(`All steps completed with exit code 0 (${plan.steps.map((s) => s.label).join(' → ')}).`);
  else { lineErr(`Failed at step: ${lastStep} (exit ${result.code}).`); result.tail.slice(-6).forEach((l) => dim(trunc(l, cols() - 8))); }
}

async function testRepo(repo) {
  rule('TEST');
  if (repo.size === 0) { lineWarn('Empty repository — nothing to test.'); return; }
  let info;
  try {
    info = await task('Analyzing project', (ctx) => analyze(repo, ctx));
  } catch (e) { showError(e); return; }
  printReport(repo, info);

  const url = liveUrl(repo);
  const methods = [];
  if (url) methods.push({ id: 'probe', label: `Probe live URL  ${gray(trunc(url, cols() - 32))}` });
  if (info.previewable) methods.push({ id: 'preview', label: 'Isolated online preview (StackBlitz)' });
  if (info.plan) methods.push({ id: 'sandbox', label: `Docker sandbox  ${gray('(' + trunc(info.plan.steps.map((s) => s.label.split(' (')[0]).join(' → '), cols() - 30) + ')')}` });

  if (methods.length === 0) {
    out('\n');
    lineWarn('This project cannot be tested automatically from here.');
    dim(info.kind === 'unknown' ? 'No recognized manifest (package.json, requirements.txt, go.mod, Cargo.toml, index.html).'
      : `No runner yet for type "${info.kind}" and no deployment URL (homepage / GitHub Pages).`);
    dim('Option: Install then run manually in a suitable environment.');
    return;
  }
  out(`\n  ${bwhite('Test methods:')}\n`);
  methods.forEach((m, i) => out(`  ${red('[' + (i + 1) + ']')} ${white(m.label)}\n`));
  out(`  ${gray('[0] Cancel')}\n`);
  const a = await ask(`\n  ${bwhite('Choose')} ${red('>')} `);
  if (a === null) shutdown(0);
  const m = methods[Number(a) - 1];
  if (!m) { lineInfo('Cancelled.'); return; }
  out('\n');

  if (m.id === 'probe') {
    try {
      const p = await task('Probing live URL', (ctx) => probeUrl(url, ctx));
      const good = p.status >= 200 && p.status < 400;
      (good ? lineOk : lineErr)(`HTTP ${p.status} · ${p.ms} ms · ${p.type.split(';')[0]} · ${p.bytes} B`);
      if (p.title) dim(`title: ${trunc(p.title, cols() - 16)}`);
      dim(`url: ${p.finalUrl}`);
      dim('This only checks that the deployment responds; not a full functional test.');
    } catch (e) { showError(e); }
  } else if (m.id === 'preview') {
    const target = `https://stackblitz.com/github/${repo.full_name}`;
    const how = openUrl(target);
    if (how) lineOk('Preview opened in the browser (runs in the StackBlitz browser sandbox, not on your device).');
    else lineWarn('Cannot open a browser from here.');
    out(`\n  ${white('URL:')} ${bwhite(target)}\n`);
    dim('View run results in StackBlitz; Stall cannot read its output.');
    dim('Projects requiring a specific database/server may fail there.');
  } else if (m.id === 'sandbox') {
    const plan = info.plan;
    const ready = await task('Preparing test environment', async () => {
      if (!commandExists('docker')) throw new StallError('docker', 'docker not found on this device.', { hint: 'Install a docker client and point it to a remote host: export DOCKER_HOST=ssh://user@server  (repo code is NOT executed on this device).' });
      if (!dockerReady()) throw new StallError('docker', 'Docker daemon not responding.', { hint: 'Start the local daemon, or set DOCKER_HOST to a remote Docker server.' });
      return true;
    }).catch((e) => { showError(e); return false; });
    if (!ready) return;
    out(`\n  ${gray('Image :')} ${white(plan.image)} ${gray('(running as non-root, 1 CPU, 768MB, no capabilities)')}\n`);
    plan.steps.forEach((s) => out(`  ${gray('Step:')} ${white(s.label)}\n`));
    dim('The container has internet access (for clone & dependency install), with no host folders or credentials mounted.');
    const c = await ask(`\n  ${bwhite('Run in sandbox?')} ${gray('[y/N]')} ${red('>')} `);
    if (!c || c.toLowerCase() !== 'y') { lineInfo('Cancelled.'); return; }
    out('\n');
    await sandboxRun(repo, plan);
  }
}

// ───────────────────────── main ─────────────────────────

async function initChecks() {
  const env = {};
  await task('Initializing Stall', async () => {
    if (typeof fetch !== 'function') throw new StallError('env', `Node ${process.versions.node} is too old; requires Node >= 18.`, { hint: IS_TERMUX ? 'Termux: pkg upgrade && pkg install nodejs' : '' });
    env.git = commandExists('git');
    env.opener = ['termux-open-url', 'xdg-open', 'open'].find(commandExists) || '';
  });
  dim(`node ${process.versions.node} · ${IS_TERMUX ? 'termux' : process.platform} · git ${env.git ? 'ok' : 'MISSING'} · browser-opener ${env.opener || 'none'}`);
  if (!env.git) dim(IS_TERMUX ? 'Install feature requires: pkg install git' : 'Install feature requires git.');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) { console.log(VERSION); return; }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Stall — browse & test public GitHub repositories from the terminal.\n\nUsage: stall   (or: node index.js)\nAccount: nullkat-067 (fixed, not configurable)\nEnv: GITHUB_TOKEN (optional), STALL_DIR, STALL_PAGE, STALL_TIMEOUT_MS, DOCKER_HOST');
    return;
  }
  initInput();
  clearScreen();
  hideCursor();
  await banner(true);
  await blink(2);
  out('\n');
  const state = { login: USER, total: null, repos: [] };
  await initChecks();
  await loadRepos(state);
  showCursor();
  await sleep(TTY ? 600 : 0);
  await listLoop(state);
}

main().catch((e) => {
  cleanup();
  console.error('\n  Fatal:', redact(e && e.message ? e.message : e));
  process.exit(1);
});

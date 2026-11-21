#!/usr/bin/env node
// warm-jsdelivr.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Keeps the PokeGuess sprite cache HOT on jsDelivr's edge PoPs.
//
// WHY THIS EXISTS
// jsDelivr has no prefetch/warm API — the only way to populate an edge PoP is to
// make a real request that the PoP serves, after which it caches the file. A file
// that nobody in a region has requested recently goes COLD (TTL lapse + LRU
// eviction when the PoP is under pressure), and the next user there pays the slow
// cold-origin path (GitHub origin, 6–13s per file) — which is exactly the
// first-install download slowness we're fixing. Running this on a cron keeps the
// 2050 WebP artworks warm so real users always hit a warm edge (~30ms/file).
//
// HOW IT REACHES MULTIPLE REGIONS
// jsDelivr is multi-CDN. The default host (cdn.jsdelivr.net) load-balances to one
// provider, but the others are ALSO addressable directly by hostname. Hitting them
// all warms each provider's network — including Quantil (China, behind the Great
// Firewall) and Cloudflare/Bunny via the default host. BUT GeoDNS routes you to the
// PoP nearest the sender, so a US runner only warms US edges. To warm EU/JP/etc.,
// pass --proxy pointing at a proxy in that region (see the --proxy notes below): the
// request then exits from there and warms that region's PoP.
//
// REQUESTS
// We use HEAD, not GET: a HEAD populates the edge cache entry just like a GET but
// transfers zero body bytes — so warming 2050 files × 4 hosts costs ~8200 tiny
// requests instead of ~172 MB of downloads. We classify each response as HIT/MISS
// (via the `Age` header first, then `x-cache`/`cf-cache-status`) so you can SEE the
// coverage, not just hope for it.
//
// USAGE
//   node warm-jsdelivr.mjs                # warm all providers, full report
//   node warm-jsdelivr.mjs --providers fastly,quantil
//   node warm-jsdelivr.mjs --concurrency 32
//   node warm-jsdelivr.mjs --proxy http://user:pass@host:port   # warm via a region
//   node warm-jsdelivr.mjs --dry-run      # print the plan, make no requests
//   node warm-jsdelivr.mjs --target atlas # the Atlas scenes instead of the sprites
//
// TARGETS
// `sprites` (default): pinned to the same frozen tag the app uses (constants.ts
// ASSETS_SPRITES_REV). The tag is immutable, so this is safe to run forever
// without coordination.
// `atlas`: the Atlas Pokémon scenes of Armytille/pokeguess-atlas, which the app
// downloads in full on its loading screen (~12,000 files per catalog). The repo
// holds one tag `<catalog version>-NN` per 35 Pokémon (jsDelivr refuses a ref
// over 50 MB). The script finds the newest catalog versions itself through the
// GitHub API (`--atlas-versions`, default 1: the catalog the builds carry;
// pass 2 while two catalogs are in use) and lists each tag's files, so a new catalog needs no change here. Set
// GITHUB_TOKEN to lift the API's anonymous limit (60 requests/hour).
// ─────────────────────────────────────────────────────────────────────────────

import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';

// `require` shim for this ES module — needed only for the one-time proxy re-exec
// (spawnSync from node:child_process). Kept at top level; imports hoist anyway.
const require = createRequire(import.meta.url);

// ── Config (keep in sync with src/utils/constants.ts) ──────────────────────────
const ASSETS_REPO = 'Armytille/pokeguess-assets';
const ASSETS_TAG  = 'v2'; // ASSETS_SPRITES_REV — frozen, won't change
const ARTWORK_PATH = 'sprites/official-artwork';
const ARTWORK_TOTAL = 1025; // IDs 1..1025 (gens 1–9)

// Atlas scenes (keep in sync with eas.json EXPO_PUBLIC_ATLAS_SCENES_URL).
const ATLAS_REPO = 'Armytille/pokeguess-atlas';
// `<catalog version>-<shard>`: 2026-11-16-07.
const ATLAS_TAG = /^(\d{4}-\d{2}-\d{2})-(\d{2})$/;

// Per-provider jsDelivr hostnames. `quantil` is the China network (the only one
// reachable behind the Great Firewall); `fastly` covers EU/US/global; `gcore` has
// strong Asia/Japan coverage. Warming each covers the network real users land on.
//
// `cloudflare.jsdelivr.net` is documented but, as of this writing, does NOT resolve
// from every region (jsDelivr GeoDNS / partial deprecation — see jsdelivr/jsdelivr
// #18408). It's intentionally left OUT of the default set; pass it explicitly with
// --providers if it comes back. The script pre-checks DNS and skips any host that
// doesn't resolve, so an absent provider degrades gracefully instead of logging
// 2050 phantom errors.
const PROVIDER_HOSTS = {
  // The DEFAULT load-balanced host — the exact one the app uses (constants.ts
  // ASSETS_BASE). It routes to whichever provider jsDelivr's balancer picks for
  // THIS sender's geo/perf (commonly Cloudflare or Bunny), so it's how we warm
  // the Cloudflare/Bunny networks: there is no `cloudflare.jsdelivr.net` host to
  // force (it doesn't resolve), but `cdn.jsdelivr.net` reaches Cloudflare when the
  // balancer prefers it. From a US runner this warms the US edge of whatever it
  // picks; through an EU proxy, the EU edge.
  default:    'cdn.jsdelivr.net',
  fastly:     'fastly.jsdelivr.net',
  gcore:      'gcore.jsdelivr.net',
  quantil:    'quantil.jsdelivr.net',
  cloudflare: 'cloudflare.jsdelivr.net', // opt-in only — does NOT resolve in most regions
};

// Providers warmed when --providers is not given. `cloudflare` is excluded (no DNS);
// the Cloudflare network is instead warmed via the `default` load-balanced host.
const DEFAULT_PROVIDERS = ['default', 'fastly', 'gcore', 'quantil'];

// ── CLI args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { target: 'sprites', atlasVersions: 1, providers: [...DEFAULT_PROVIDERS], concurrency: 24, dryRun: false, timeoutMs: 15000, retries: 2, maxErrorRate: 0.05, deadlineMin: 0, proxy: process.env.WARM_PROXY || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--atlas-versions') args.atlasVersions = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--providers') args.providers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--concurrency') args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 24);
    else if (a === '--timeout') args.timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 15000);
    else if (a === '--retries') args.retries = Math.max(0, parseInt(argv[++i], 10) || 0);
    // Fraction of requests allowed to fail before the run exits non-zero. Default
    // 5% for the reliable direct pipeline; raise it (e.g. 0.5) for flaky transports
    // where a partial warm is still a useful warm.
    else if (a === '--max-error-rate') args.maxErrorRate = Math.min(1, Math.max(0, parseFloat(argv[++i]) || 0.05));
    // Stop taking new files after this many minutes and report what was done.
    // A CI job that hits its own timeout is cancelled with no summary at all
    // (the proxy runs ended that way every week from 2026-10 to 2026-11).
    else if (a === '--deadline') args.deadlineMin = Math.max(0, parseFloat(argv[++i]) || 0);
    // Route all requests through an HTTP proxy (e.g. http://user:pass@host:port).
    // This is how we warm NON-US edges: a proxy in DE/JP makes jsDelivr's GeoDNS
    // see that region's IP AND resolves DNS proxy-side, so routing matches the
    // exit geo (unlike Tor, where Node's local DNS leaked the US location). Can
    // also be set via the WARM_PROXY env var (preferred in CI to keep creds out
    // of the process args / logs).
    else if (a === '--proxy') args.proxy = argv[++i] || '';
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (args.target !== 'sprites' && args.target !== 'atlas') {
    console.error(`Unknown target: ${args.target}. Valid: sprites, atlas`);
    process.exit(2);
  }
  const unknown = args.providers.filter((p) => !PROVIDER_HOSTS[p]);
  if (unknown.length) {
    console.error(`Unknown provider(s): ${unknown.join(', ')}. Valid: ${Object.keys(PROVIDER_HOSTS).join(', ')}`);
    process.exit(2);
  }
  return args;
}

function printHelp() {
  console.log(`warm-jsdelivr — keep PokeGuess sprites warm on jsDelivr edges

  --target <name>       sprites (default) or atlas (the Atlas scenes)
  --atlas-versions <n>  atlas: how many of the newest catalog versions (default: 1)
  --providers <list>    comma-separated: ${Object.keys(PROVIDER_HOSTS).join(',')} (default: all)
  --concurrency <n>     parallel in-flight HEAD requests per provider (default: 24)
  --timeout <ms>        per-request timeout (default: 15000)
  --retries <n>         transient-failure retries per URL (default: 2)
  --max-error-rate <f>  fail the run above this error fraction (default: 0.05)
  --deadline <min>      stop taking new files after this many minutes (default: none)
  --proxy <url>         route via HTTP proxy http://user:pass@host:port
                        (or set WARM_PROXY env var) — warms that proxy's region
  --dry-run             print the plan, make no requests
  -h, --help            this help`);
}

// ── URL list ─────────────────────────────────────────────────────────────────
// Build the 2050 path suffixes once; each provider prepends its own host. We warm
// paths (not full URLs to one host) so the same list is reused across providers.
function buildPaths() {
  const base = `/gh/${ASSETS_REPO}@${ASSETS_TAG}/${ARTWORK_PATH}`;
  const paths = [];
  for (let id = 1; id <= ARTWORK_TOTAL; id++) {
    paths.push(`${base}/${id}.webp`);        // normal
    paths.push(`${base}/shiny/${id}.webp`);  // shiny
  }
  return paths;
}

// The Atlas scenes: every file of every tag of the newest catalog versions.
// One GitHub API call lists the tags, one per tag lists its files (each tag is
// an orphan commit holding only its shard, ~420 files, far under the tree
// API's truncation limit).
async function githubJson(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'warm-jsdelivr' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.ok) return res.json();
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function buildAtlasPaths(versionsWanted) {
  const tags = [];
  for (let page = 1; ; page++) {
    const batch = await githubJson(`/repos/${ATLAS_REPO}/tags?per_page=100&page=${page}`);
    tags.push(...batch.map((t) => t.name));
    if (batch.length < 100) break;
  }
  const byVersion = new Map();
  for (const name of tags) {
    const m = ATLAS_TAG.exec(name);
    if (!m) continue;
    if (!byVersion.has(m[1])) byVersion.set(m[1], []);
    byVersion.get(m[1]).push(name);
  }
  // Dates sort as strings: the newest catalogs last.
  const versions = [...byVersion.keys()].sort().slice(-versionsWanted).reverse();
  if (versions.length === 0) throw new Error(`no <version>-NN tag in ${ATLAS_REPO}`);
  const paths = [];
  for (const version of versions) {
    for (const tag of byVersion.get(version).sort()) {
      const tree = await githubJson(`/repos/${ATLAS_REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`);
      if (tree.truncated) console.warn(`  ⚠ ${tag}: the tree listing is truncated, some files will stay cold`);
      for (const entry of tree.tree) {
        if (entry.type === 'blob' && entry.path.startsWith('pokemon/')) paths.push(`/gh/${ATLAS_REPO}@${tag}/${entry.path}`);
      }
    }
  }
  return { paths, label: `${ATLAS_REPO} @ ${versions.join(', ')} (${versions.map((v) => byVersion.get(v).length).join(' + ')} tags)` };
}

// ── HIT/MISS classification ────────────────────────────────────────────────────
// Each jsDelivr provider reports cache state its own way, so there is no single
// reliable `x-cache` convention:
//   - Fastly:  `x-cache: HIT`/`MISS` (and `x-served-by` PoP chain).
//   - Quantil: `x-cache: HIT` once warm.
//   - Gcore:   ALWAYS emits `x-cache: MISS, MISS` even when the object is plainly
//              being served from cache (verified: `age` > 0 on a first GET).
// The ONE signal every HTTP cache populates consistently is the `Age` header:
// RFC 9111 says a shared cache MUST send `Age` ≥ the seconds the response has sat
// in cache, so `age > 0` is a provider-agnostic proof the object was served from
// an edge cache, not fetched fresh from origin. We trust `age` first, and only
// fall back to the textual `x-cache` when no age is present.
function classifyCache(headers) {
  const age = parseInt(headers.get('age') || '', 10);
  if (Number.isFinite(age) && age > 0) return 'HIT';
  const xCache = (headers.get('x-cache') || headers.get('cf-cache-status') || '').toUpperCase();
  if (xCache.includes('HIT')) return 'HIT';
  if (xCache.includes('MISS') || xCache.includes('EXPIRED') || xCache.includes('REVALIDATED')) return 'MISS';
  return age === 0 ? 'MISS' : 'UNKNOWN'; // explicit age:0 = freshly fetched (cold)
}

// ── One warming request (HEAD) with bounded retries ──────────────────────────
// Bytes of one HEAD exchange on a kept-alive connection: the request line and
// headers (measured with curl: ~150 B) plus the response headers. A proxy's
// quota counts these, so the summary reports the sum.
const REQUEST_BYTES = 160;
function headerBytes(headers) {
  let n = 17; // status line
  for (const [k, v] of headers) n += k.length + v.length + 4;
  return n;
}

// Why a request failed, in a few words: undici hides the cause one level down
// ("fetch failed" → "Proxy response (402) !== 200 when HTTP Tunneling",
// ECONNREFUSED, a timeout). The first few distinct ones go into the log.
function errorReason(err) {
  if (err?.name === 'AbortError') return 'no answer before --timeout';
  const cause = err?.cause;
  return String(cause?.code || cause?.message || err?.message || err).slice(0, 160);
}

async function warmOne(url, { timeoutMs, retries }) {
  let reason = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      clearTimeout(timer);
      const bytes = REQUEST_BYTES + headerBytes(res.headers);
      if (res.ok) return { ok: true, cache: classifyCache(res.headers), status: res.status, bytes };
      // 4xx (other than 408/429) won't improve on retry — a genuinely missing file.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, cache: 'ERR', status: res.status, bytes, reason: `HTTP ${res.status}` };
      }
      reason = `HTTP ${res.status}`;
      // 5xx/408/429 → fall through to backoff.
    } catch (err) {
      clearTimeout(timer);
      reason = errorReason(err);
      // network error / timeout / abort → retry
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
  }
  return { ok: false, cache: 'ERR', status: 0, bytes: 0, reason };
}

// ── Proxy check ────────────────────────────────────────────────────────────────
// A proxy that is gone (free proxy lists rotate) or out of quota fails every
// request, and each one waits out --timeout and its retries: with 2,000 files
// that is hours, and the CI job was cancelled at its limit before it printed a
// line. Four requests up front tell a working proxy from a dead one in seconds.
async function proxyWorks(url, timeoutMs) {
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await warmOne(url, { timeoutMs: Math.min(timeoutMs, 15000), retries: 0 }));
  const ok = results.filter((r) => r.ok).length;
  return { ok: ok >= 2, detail: `${ok}/4 answered${ok < 4 ? ` (${[...new Set(results.filter((r) => !r.ok).map((r) => r.reason))].join('; ')})` : ''}` };
}

// ── Bounded-concurrency pool over a path list for one provider ─────────────────
// Stop a provider whose requests keep failing: past BREAKER_MIN requests, an
// error rate above BREAKER_RATE means the path is down (a dead proxy, a quota
// spent), and going on only burns the job's time.
const BREAKER_MIN = 200;
const BREAKER_RATE = 0.5;
const PROGRESS_EVERY = 2000;

async function warmProvider(provider, host, paths, opts, deadline) {
  const stats = { provider, total: paths.length, done: 0, ok: 0, err: 0, HIT: 0, MISS: 0, UNKNOWN: 0, bytes: 0, reasons: new Map(), stopped: '' };
  let cursor = 0;
  const started = Date.now();

  const worker = async () => {
    while (cursor < paths.length && !stats.stopped) {
      if (deadline && Date.now() > deadline) { stats.stopped = 'deadline reached'; break; }
      const url = `https://${host}${paths[cursor++]}`;
      const r = await warmOne(url, opts);
      stats.done++;
      stats.bytes += r.bytes;
      if (r.ok) { stats.ok++; stats[r.cache] = (stats[r.cache] || 0) + 1; }
      else {
        stats.err++;
        stats.reasons.set(r.reason, (stats.reasons.get(r.reason) || 0) + 1);
        if (stats.done >= BREAKER_MIN && stats.err > stats.done * BREAKER_RATE && !stats.stopped) {
          stats.stopped = `${stats.err} of ${stats.done} requests failed`;
        }
      }
      if (stats.done % PROGRESS_EVERY === 0) {
        process.stdout.write(`\n  … ${stats.done}/${paths.length}  HIT=${stats.HIT} MISS=${stats.MISS} err=${stats.err}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  stats.elapsedMs = Date.now() - started;
  return stats;
}

// ── DNS pre-check ──────────────────────────────────────────────────────────────
// A provider hostname that doesn't resolve (e.g. cloudflare.jsdelivr.net in some
// regions) would otherwise turn into `paths.length` phantom network errors. Drop
// such providers up front so the run targets only reachable networks and the
// error-rate gate stays meaningful.
async function resolvableProviders(providers) {
  const live = [];
  for (const p of providers) {
    try {
      await lookup(PROVIDER_HOSTS[p]);
      live.push(p);
    } catch {
      console.warn(`  ⚠ ${p} (${PROVIDER_HOSTS[p]}) does not resolve — skipping`);
    }
  }
  return live;
}

// ── Proxy re-exec ──────────────────────────────────────────────────────────────
// Node only honors a proxy for the native `fetch` when started with
// `--use-env-proxy` and HTTPS_PROXY/HTTP_PROXY set in the environment (there is no
// runtime API to enable it, and the `undici` package isn't importable). So when a
// proxy is requested we re-launch ourselves once with those set, marking the child
// via WARM_PROXY_ACTIVE so it doesn't re-exec again. Credentials live in the env,
// never on the command line (keeps them out of `ps` / CI logs).
function reExecWithProxy(proxyUrl, extraEnv = {}) {
  const { spawnSync } = require('node:child_process');
  // Drop --proxy + its value so the child doesn't loop; it reads the proxy from env.
  const childArgs = [];
  const orig = process.argv.slice(2);
  for (let i = 0; i < orig.length; i++) {
    if (orig[i] === '--proxy') { i++; continue; } // skip flag + its value
    childArgs.push(orig[i]);
  }
  const res = spawnSync(process.execPath, ['--use-env-proxy', process.argv[1], ...childArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NODE_USE_ENV_PROXY: '1',
      WARM_PROXY_ACTIVE: proxyUrl,
      ...extraEnv,
    },
  });
  if (extraEnv.WARM_PATHS_FILE) {
    try { require('node:fs').unlinkSync(extraEnv.WARM_PATHS_FILE); } catch { /* already gone */ }
  }
  process.exit(res.status ?? 1);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let paths;
  let label = `${ASSETS_REPO}@${ASSETS_TAG}`;
  let detail = `${ARTWORK_TOTAL} normal + ${ARTWORK_TOTAL} shiny`;
  if (args.target === 'atlas') {
    // The list is built once, outside the proxy: the GitHub API calls need no
    // region, and a proxied child reads the list from the file it is handed.
    if (process.env.WARM_PATHS_FILE) {
      ({ paths, label } = JSON.parse(require('node:fs').readFileSync(process.env.WARM_PATHS_FILE, 'utf8')));
    } else {
      ({ paths, label } = await buildAtlasPaths(args.atlasVersions));
    }
    detail = 'Atlas scene files';
  } else {
    paths = buildPaths();
  }

  // Proxy routing uses Node's native env-proxy support, NOT the `undici` package
  // (which is bundled into `fetch` but is NOT importable as a bare module — that
  // would crash in CI). When --proxy is given we set HTTPS_PROXY/HTTP_PROXY in the
  // env and re-exec under `node --use-env-proxy`, which makes the global `fetch`
  // tunnel through the proxy AND resolve DNS proxy-side — so jsDelivr GeoDNS sees
  // the proxy's region (the whole point) instead of the runner's. See reExecWithProxy.
  if (args.proxy && !process.env.WARM_PROXY_ACTIVE) {
    if (args.target !== 'atlas') return reExecWithProxy(args.proxy);
    const fs = require('node:fs');
    const file = require('node:path').join(require('node:os').tmpdir(), `warm-atlas-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ paths, label }));
    return reExecWithProxy(args.proxy, { WARM_PATHS_FILE: file });
  }
  if (process.env.WARM_PROXY_ACTIVE) {
    const safe = process.env.WARM_PROXY_ACTIVE.replace(/\/\/[^@]*@/, '//***@');
    console.log(`  proxy:       ${safe}`);
  }

  // Skip the local DNS pre-check when proxying: resolution happens proxy-side, so
  // a local `lookup` would wrongly drop providers (this is exactly the failure the
  // Tor attempt hit). Without a proxy, keep the pre-check to prune dead hosts.
  if (!args.dryRun && !process.env.WARM_PROXY_ACTIVE) {
    args.providers = await resolvableProviders(args.providers);
    if (args.providers.length === 0) {
      console.error('No provider hostnames resolved — nothing to warm.');
      process.exit(1);
    }
  }

  const totalReq = paths.length * args.providers.length;

  console.log(`warm-jsdelivr → ${label}`);
  console.log(`  files:       ${paths.length} (${detail})`);
  console.log(`  providers:   ${args.providers.join(', ')}`);
  console.log(`  requests:    ${totalReq} HEAD  (concurrency ${args.concurrency}/provider)`);
  if (args.dryRun) {
    console.log('\n--dry-run: no requests made. Sample URLs:');
    for (const p of args.providers) console.log(`  https://${PROVIDER_HOSTS[p]}${paths[0]}`);
    return;
  }

  // Through a proxy, check it carries requests at all before the long run.
  if (process.env.WARM_PROXY_ACTIVE) {
    const check = await proxyWorks(`https://${PROVIDER_HOSTS[args.providers[0]]}${paths[0]}`, args.timeoutMs);
    console.log(`  proxy check: ${check.detail}`);
    if (!check.ok) {
      console.error('\nFAIL: the proxy does not carry requests (gone, refused, or out of quota). Replace it in the WEBSHARE_PROXIES secret.');
      process.exit(3);
    }
  }

  const deadline = args.deadlineMin > 0 ? Date.now() + args.deadlineMin * 60_000 : 0;
  const results = [];
  // Providers run sequentially so we don't thrash the local NIC with
  // concurrency × providers sockets at once; each provider gets a clean budget.
  for (const p of args.providers) {
    if (deadline && Date.now() > deadline) { console.log(`\n[${p}] skipped: deadline reached`); continue; }
    process.stdout.write(`\n[${p}] warming ${paths.length} files … `);
    const s = await warmProvider(p, PROVIDER_HOSTS[p], paths, args, deadline);
    results.push(s);
    console.log(`\n  done in ${(s.elapsedMs / 1000).toFixed(1)}s${s.stopped ? `, STOPPED (${s.stopped}) after ${s.done}/${s.total}` : ''}`);
    console.log(`  ok=${s.ok} err=${s.err}  |  HIT=${s.HIT} MISS=${s.MISS} UNKNOWN=${s.UNKNOWN}`);
    for (const [reason, count] of [...s.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`  error ×${count}: ${reason}`);
  }

  // ── Summary + exit code ──────────────────────────────────────────────────────
  const totErr = results.reduce((n, s) => n + s.err, 0);
  const totHit = results.reduce((n, s) => n + s.HIT, 0);
  const totOk  = results.reduce((n, s) => n + s.ok, 0);
  const totDone = results.reduce((n, s) => n + s.done, 0);
  const totBytes = results.reduce((n, s) => n + s.bytes, 0);
  const hitRate = totOk ? ((totHit / totOk) * 100).toFixed(1) : '0.0';
  console.log(`\n──────── summary ────────`);
  console.log(`  reachable: ${totOk}/${totalReq}   errors: ${totErr}   not reached: ${totalReq - totDone}`);
  console.log(`  warm (HIT): ${totHit}/${totOk}  (${hitRate}%)`);
  console.log(`  traffic: ≈ ${(totBytes / 1e6).toFixed(1)} MB of headers (plus one TLS handshake per connection)`);
  console.log(`  note: a high MISS rate on the FIRST run is expected — those requests`);
  console.log(`        just warmed the edge. The next run should report mostly HIT.`);

  // Fail the CI job only if too large a fraction of files were unreachable. The
  // threshold is configurable (--max-error-rate) so flaky transports tolerate a
  // higher miss rate while the direct pipeline stays strict at 5%. A provider
  // stopped by its errors fails the run too: its files stayed cold.
  const stopped = results.filter((s) => s.stopped && s.stopped !== 'deadline reached');
  if (totErr > Math.max(1, totDone) * args.maxErrorRate || stopped.length) {
    console.error(`\nFAIL: ${totErr} errors in ${totDone} requests${stopped.length ? `; stopped: ${stopped.map((s) => s.provider).join(', ')}` : ''}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('warm-jsdelivr crashed:', err);
  process.exit(1);
});

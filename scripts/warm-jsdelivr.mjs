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
// HOW IT REACHES MULTIPLE REGIONS FROM ONE MACHINE
// jsDelivr is multi-CDN. The default host (cdn.jsdelivr.net) load-balances to one
// provider, but the others are ALSO addressable directly by hostname. Hitting them
// all from a single runner warms each provider's network — including Quantil, the
// only provider reachable inside China (behind the Great Firewall), and Cloudflare/
// Bunny via the default host. The exact PoP still depends on the runner's geo, but
// each provider keeps its own cache, so covering all of them covers the networks
// real users land on.
//
// NOTE on regional coverage: from one machine, jsDelivr GeoDNS routes you to the
// PoP nearest YOU, so a US runner only warms US edges. To warm EU/JP edges too,
// run this through a country-pinned egress (see .github/workflows/warm-jsdelivr-tor.yml,
// which tunnels this same script through Tor exit nodes in DE/JP).
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
//   node warm-jsdelivr.mjs --dry-run      # print the plan, make no requests
//
// Pinned to the same frozen tag the app uses (constants.ts ASSETS_SPRITES_REV).
// The tag is immutable, so this is safe to run forever without coordination.
// ─────────────────────────────────────────────────────────────────────────────

import { lookup } from 'node:dns/promises';

// ── Config (keep in sync with src/utils/constants.ts) ──────────────────────────
const ASSETS_REPO = 'Armytille/pokeguess-assets';
const ASSETS_TAG  = 'v2'; // ASSETS_SPRITES_REV — frozen, won't change
const ARTWORK_PATH = 'sprites/official-artwork';
const ARTWORK_TOTAL = 1025; // IDs 1..1025 (gens 1–9)

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
  // THIS runner's geo/perf (commonly Cloudflare or Bunny), so it's how we warm
  // the Cloudflare/Bunny networks: there is no `cloudflare.jsdelivr.net` host to
  // force (it doesn't resolve), but `cdn.jsdelivr.net` reaches Cloudflare when the
  // balancer prefers it. From a US runner this warms the US edge of whatever it
  // picks; from EU, the EU edge.
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
  const args = { providers: [...DEFAULT_PROVIDERS], concurrency: 24, dryRun: false, timeoutMs: 15000, retries: 2, maxErrorRate: 0.05 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--providers') args.providers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--concurrency') args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 24);
    else if (a === '--timeout') args.timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 15000);
    else if (a === '--retries') args.retries = Math.max(0, parseInt(argv[++i], 10) || 0);
    // Fraction of requests allowed to fail before the run exits non-zero. Default
    // 5% for the reliable direct pipeline; raise it (e.g. 0.5) for flaky transports
    // like Tor where a partial warm is still a useful warm.
    else if (a === '--max-error-rate') args.maxErrorRate = Math.min(1, Math.max(0, parseFloat(argv[++i]) || 0.05));
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
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

  --providers <list>    comma-separated: ${Object.keys(PROVIDER_HOSTS).join(',')} (default: all)
  --concurrency <n>     parallel in-flight HEAD requests per provider (default: 24)
  --timeout <ms>        per-request timeout (default: 15000)
  --retries <n>         transient-failure retries per URL (default: 2)
  --max-error-rate <f>  fail the run above this error fraction (default: 0.05)
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
async function warmOne(url, { timeoutMs, retries }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) return { ok: true, cache: classifyCache(res.headers), status: res.status };
      // 4xx (other than 408/429) won't improve on retry — a genuinely missing file.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, cache: 'ERR', status: res.status };
      }
      // 5xx/408/429 → fall through to backoff.
    } catch {
      clearTimeout(timer);
      // network error / timeout / abort → retry
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
  }
  return { ok: false, cache: 'ERR', status: 0 };
}

// ── Bounded-concurrency pool over a path list for one provider ─────────────────
async function warmProvider(provider, host, paths, opts) {
  const stats = { provider, total: paths.length, ok: 0, err: 0, HIT: 0, MISS: 0, UNKNOWN: 0 };
  let cursor = 0;
  const started = Date.now();

  const worker = async () => {
    while (cursor < paths.length) {
      const url = `https://${host}${paths[cursor++]}`;
      const r = await warmOne(url, opts);
      if (r.ok) { stats.ok++; stats[r.cache] = (stats[r.cache] || 0) + 1; }
      else stats.err++;
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = buildPaths();

  if (!args.dryRun) {
    args.providers = await resolvableProviders(args.providers);
    if (args.providers.length === 0) {
      console.error('No provider hostnames resolved — nothing to warm.');
      process.exit(1);
    }
  }

  const totalReq = paths.length * args.providers.length;

  console.log(`warm-jsdelivr → ${ASSETS_REPO}@${ASSETS_TAG}`);
  console.log(`  files:       ${paths.length} (${ARTWORK_TOTAL} normal + ${ARTWORK_TOTAL} shiny)`);
  console.log(`  providers:   ${args.providers.join(', ')}`);
  console.log(`  requests:    ${totalReq} HEAD  (concurrency ${args.concurrency}/provider)`);
  if (args.dryRun) {
    console.log('\n--dry-run: no requests made. Sample URLs:');
    for (const p of args.providers) console.log(`  https://${PROVIDER_HOSTS[p]}${paths[0]}`);
    return;
  }

  const results = [];
  // Providers run sequentially so we don't thrash the local NIC with
  // concurrency × providers sockets at once; each provider gets a clean budget.
  for (const p of args.providers) {
    process.stdout.write(`\n[${p}] warming ${paths.length} files … `);
    const s = await warmProvider(p, PROVIDER_HOSTS[p], paths, args);
    results.push(s);
    console.log(`done in ${(s.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`  ok=${s.ok} err=${s.err}  |  HIT=${s.HIT} MISS=${s.MISS} UNKNOWN=${s.UNKNOWN}`);
  }

  // ── Summary + exit code ──────────────────────────────────────────────────────
  const totErr = results.reduce((n, s) => n + s.err, 0);
  const totHit = results.reduce((n, s) => n + s.HIT, 0);
  const totOk  = results.reduce((n, s) => n + s.ok, 0);
  const hitRate = totOk ? ((totHit / totOk) * 100).toFixed(1) : '0.0';
  console.log(`\n──────── summary ────────`);
  console.log(`  reachable: ${totOk}/${totalReq}   errors: ${totErr}`);
  console.log(`  warm (HIT): ${totHit}/${totOk}  (${hitRate}%)`);
  console.log(`  note: a high MISS rate on the FIRST run is expected — those requests`);
  console.log(`        just warmed the edge. The next run should report mostly HIT.`);

  // Fail the CI job only if too large a fraction of files were unreachable. The
  // threshold is configurable (--max-error-rate) so flaky transports like Tor can
  // tolerate a higher miss rate while the direct pipeline stays strict at 5%.
  if (totErr > totalReq * args.maxErrorRate) {
    console.error(`\nFAIL: ${totErr} errors exceed ${(args.maxErrorRate * 100).toFixed(0)}% of ${totalReq} requests.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('warm-jsdelivr crashed:', err);
  process.exit(1);
});

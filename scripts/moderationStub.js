#!/usr/bin/env node
/**
 * A local stand-in for the two moderation services.
 *
 *     npm run stub:moderation            # port 8787
 *     PORT=9000 npm run stub:moderation
 *
 * Then point the backend at it:
 *     TEXT_MODERATION_URL=http://localhost:8787
 *     IMAGE_MODERATION_URL=http://localhost:8787
 *
 * Why this exists: moderation fails CLOSED, so testing a rejection against the real
 * Hugging Face Spaces means waiting out a cold start (measured at 60s+) and hoping the
 * model gives the verdict you need. Neither is repeatable. This answers instantly and
 * says exactly what you ask it to.
 *
 * It is NOT a model and proves nothing about real moderation quality. Prove the real
 * chain once with scripts/pipelineLiveCheck.js, then use this for the repetition.
 *
 * ── Control it from the content, not from a flag ──────────────────────────────
 * The verdict is driven by the text (or image URL) in the request, so a single running
 * stub can serve an accept and a reject in the same test with no restart:
 *
 *   contains "REJECT"   -> unsafe, high scores
 *   contains "SLOW"     -> waits SLOW_MS (default 45s) so the caller times out,
 *                          exercising the 503 MODERATION_UNAVAILABLE path
 *   contains "BOOM"     -> 500, exercising the same fail-closed branch differently
 *   anything else       -> safe
 *
 * Response shapes mirror services/moderationClients.js exactly:
 *   GET  /moderate?text=...        -> { safe, scores: {...} }
 *   POST /moderate-images {urls[]} -> { safe, nsfw_score, violence_score, reason }
 */
const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const SLOW_MS = Number(process.env.SLOW_MS || 45000);

const SAFE_SCORES = {
  toxicity: 0.01,
  severe_toxicity: 0.0,
  obscene: 0.01,
  threat: 0.0,
  insult: 0.01,
  identity_attack: 0.0,
};

const UNSAFE_SCORES = {
  toxicity: 0.97,
  severe_toxicity: 0.81,
  obscene: 0.74,
  threat: 0.44,
  insult: 0.93,
  identity_attack: 0.12,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });

/** Pure: what should this subject produce? Exported for the tests. */
function verdictFor(subject) {
  const text = String(subject || '').toUpperCase();
  if (text.includes('BOOM')) return 'error';
  if (text.includes('SLOW')) return 'slow';
  if (text.includes('REJECT')) return 'unsafe';
  return 'safe';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return send(res, 200, { status: 'healthy', stub: true });
  }

  // --- text ---------------------------------------------------------------------
  if (url.pathname === '/moderate' && req.method === 'GET') {
    const text = url.searchParams.get('text') || '';
    const verdict = verdictFor(text);
    console.log(`  text   "${text.slice(0, 60)}" -> ${verdict}`);

    if (verdict === 'slow') { await sleep(SLOW_MS); }
    if (verdict === 'error') return send(res, 500, { error: 'stub failure' });

    return send(res, 200, {
      safe: verdict === 'safe',
      scores: verdict === 'safe' ? SAFE_SCORES : UNSAFE_SCORES,
    });
  }

  // --- images -------------------------------------------------------------------
  if (url.pathname === '/moderate-images' && req.method === 'POST') {
    const { urls = [] } = await readBody(req);
    // The pipeline sends one URL per call, but the contract is a list.
    const verdict = verdictFor(urls.join(' '));
    console.log(`  image  ${urls.length} url(s) -> ${verdict}`);

    if (verdict === 'slow') { await sleep(SLOW_MS); }
    if (verdict === 'error') return send(res, 500, { error: 'stub failure' });

    return send(res, 200, {
      safe: verdict === 'safe',
      nsfw_score: verdict === 'safe' ? 0.02 : 0.95,
      violence_score: verdict === 'safe' ? 0.01 : 0.88,
      reason: verdict === 'safe' ? null : 'stub: url contained REJECT',
    });
  }

  send(res, 404, { error: 'not found', hint: 'GET /moderate?text= or POST /moderate-images' });
}

if (require.main === module) {
  http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: err.message }));
  }).listen(PORT, () => {
    console.log(`\nModeration stub on http://localhost:${PORT}`);
    console.log('  TEXT_MODERATION_URL=http://localhost:' + PORT);
    console.log('  IMAGE_MODERATION_URL=http://localhost:' + PORT);
    console.log('  say REJECT to be refused, SLOW to time out, BOOM for a 500\n');
  });
}

module.exports = { verdictFor };

// devbridge OAuth 2.1 - the authorization server ChatGPT talks to, in the same process.
//
// WHY. ChatGPT's MCP connectors accept only "no auth" or OAuth. Until 23/09 the bridge
// used "no auth" with a static token in the URL path (/mcp/<token>): every proxy and
// tunnel log recorded the secret (34 copies in tunnel.log), and the URL was the whole
// credential. With OAuth the URL carries nothing, and every token is short-lived.
//
// SHAPE (MCP authorization spec, as ChatGPT implements it):
//   - protected resource metadata  /.well-known/oauth-protected-resource
//   - authorization server metadata /.well-known/oauth-authorization-server (iss, S256)
//   - dynamic client registration   POST /oauth/register
//   - authorize (code + PKCE S256)  GET  /oauth/authorize  -> consent page
//   - token                         POST /oauth/token (authorization_code, refresh_token)
//
// THE HUMAN IN THE LOOP. The consent page does not trust whoever opened it: approving
// requires the local admin token (~/.config/devbridge/token), which only the owner of
// this Mac can read. A stranger who finds the public URL can register a client and open
// the page, and gets nowhere. Grants, clients and tokens are persisted (0600) so a
// restart does not unlink ChatGPT.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.config', 'devbridge');
const STATE = path.join(DIR, 'oauth.json');

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 300;
export const SCOPE = 'devbridge';

const sha256b64url = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** Tokens are stored hashed: a leaked oauth.json does not hand out live credentials. */
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { clients: {}, access: {}, refresh: {} }; }
}
function save(s) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}
function prune(s) {
  const t = now();
  for (const [k, v] of Object.entries(s.access)) if (v.exp <= t) delete s.access[k];
  for (const [k, v] of Object.entries(s.refresh)) if (v.exp <= t) delete s.refresh[k];
  return s;
}

/** Pending authorization codes live only in memory: they expire in minutes anyway. */
const codes = new Map();

export function createOAuth({ issuer, adminToken }) {
  const iss = issuer.replace(/\/+$/, '');
  const resource = `${iss}/mcp`;

  const json = (res, code, body, extra = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  const html = (res, code, body) => {
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'x-frame-options': 'DENY',
    });
    res.end(body);
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const resourceMetadata = () => ({
    resource,
    authorization_servers: [iss],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  });
  const serverMetadata = () => ({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  });

  /** WWW-Authenticate for a 401 on /mcp: how ChatGPT discovers the metadata. */
  const challenge = () => `Bearer resource_metadata="${iss}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;

  /** The access token of an Authorization header, if valid. */
  function verifyAccess(authHeader) {
    const m = /^Bearer (.+)$/.exec(authHeader || '');
    if (!m) return null;
    const s = load();
    const rec = s.access[hash(m[1])];
    if (!rec || rec.exp <= now() || rec.resource !== resource) return null;
    return rec;
  }

  function readForm(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) { try { return resolve(JSON.parse(body || '{}')); } catch { return resolve({}); } }
        resolve(Object.fromEntries(new URLSearchParams(body)));
      });
    });
  }

  function issueTokens(s, clientId) {
    const access = rand(), refresh = rand();
    s.access[hash(access)] = { client_id: clientId, exp: now() + ACCESS_TTL_S, resource, scope: SCOPE };
    s.refresh[hash(refresh)] = { client_id: clientId, exp: now() + REFRESH_TTL_S, resource };
    save(prune(s));
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }

  function consentPage({ client, q, error }) {
    const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    return `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Bridge</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
code{background:#f1f1f1;padding:.1rem .3rem;border-radius:4px}input[type=password]{width:100%;padding:.6rem;font:inherit;margin:.5rem 0 1rem}
button{padding:.6rem 1rem;font:inherit}.err{color:#b00020}.warn{background:#fff4e5;padding:.8rem;border-radius:6px}</style>
<h1>Collegare Dev Bridge?</h1>
<p><b>${esc(client.client_name || 'Un client')}</b> chiede di usare Dev Bridge su questo Mac.</p>
<p class="warn">Da remoto potra leggere i progetti e lavorare solo nella sandbox (<code>~/devbridge-sandbox</code>): nessuna scrittura altrove, niente push, niente Windows.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label>Token di amministrazione (<code>~/.config/devbridge/token</code>)<input type="password" name="admin_token" autocomplete="off" required></label>
<button type="submit" name="decision" value="allow">Consenti</button>
<button type="submit" name="decision" value="deny">Rifiuta</button>
</form></html>`;
  }

  /** Handles every OAuth route. Returns true when the request was one of them. */
  async function route(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
      json(res, 200, resourceMetadata()); return true;
    }
    if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) {
      json(res, 200, serverMetadata()); return true;
    }

    if (req.method === 'POST' && p === '/oauth/register') {
      const body = await readForm(req);
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
      // Only https redirects (ChatGPT's) and loopback for local testing.
      const ok = uris.length > 0 && uris.every((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u));
      if (!ok) { json(res, 400, { error: 'invalid_redirect_uri' }); return true; }
      const s = load();
      const client_id = rand(18);
      s.clients[client_id] = { redirect_uris: uris, client_name: String(body.client_name || '').slice(0, 80), created: now() };
      save(s);
      json(res, 201, {
        client_id, client_id_issued_at: now(), redirect_uris: uris,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
      return true;
    }

    if (p === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const q = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readForm(req);
      const s = load();
      const client = s.clients[q.client_id];
      // A bad client or redirect is never redirected to: that is how open redirects happen.
      if (!client || !client.redirect_uris.includes(q.redirect_uri)) { html(res, 400, '<p>Client o redirect non registrati.</p>'); return true; }
      const back = (params) => {
        const u = new URL(q.redirect_uri);
        for (const [k, v] of Object.entries({ ...params, iss, ...(q.state ? { state: q.state } : {}) })) u.searchParams.set(k, v);
        res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end();
      };
      if (q.response_type !== 'code') { back({ error: 'unsupported_response_type' }); return true; }
      if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || '')) {
        back({ error: 'invalid_request', error_description: 'PKCE S256 required' }); return true;
      }
      if (q.resource && q.resource !== resource) { back({ error: 'invalid_target' }); return true; }

      const params = {
        response_type: q.response_type, client_id: q.client_id, redirect_uri: q.redirect_uri,
        code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method,
        ...(q.state ? { state: q.state } : {}), ...(q.scope ? { scope: q.scope } : {}), ...(q.resource ? { resource: q.resource } : {}),
      };
      if (req.method === 'GET') { html(res, 200, consentPage({ client, q: params })); return true; }

      if (q.decision !== 'allow') { back({ error: 'access_denied' }); return true; }
      const given = Buffer.from(String(q.admin_token || ''));
      const want = Buffer.from(adminToken);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        html(res, 401, consentPage({ client, q: params, error: 'Token non valido.' })); return true;
      }
      const code = rand();
      codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, exp: now() + CODE_TTL_S });
      back({ code });
      return true;
    }

    if (req.method === 'POST' && p === '/oauth/token') {
      const b = await readForm(req);
      const s = load();
      if (b.grant_type === 'authorization_code') {
        const c = codes.get(b.code);
        codes.delete(b.code); // single use, whatever happens next
        if (!c || c.exp <= now() || c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) {
          json(res, 400, { error: 'invalid_grant' }); return true;
        }
        if (sha256b64url(String(b.code_verifier || '')) !== c.challenge) { json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' }); return true; }
        json(res, 200, issueTokens(s, c.client_id)); return true;
      }
      if (b.grant_type === 'refresh_token') {
        const k = hash(String(b.refresh_token || ''));
        const r = s.refresh[k];
        if (!r || r.exp <= now() || (b.client_id && r.client_id !== b.client_id)) { json(res, 400, { error: 'invalid_grant' }); return true; }
        delete s.refresh[k]; // rotation: a refresh token works once
        json(res, 200, issueTokens(s, r.client_id)); return true;
      }
      json(res, 400, { error: 'unsupported_grant_type' }); return true;
    }
    return false;
  }

  return { route, verifyAccess, challenge, resource };
}

/** Revoke every OAuth grant: the kill switch. */
export function revokeAll() {
  const s = load();
  s.access = {}; s.refresh = {};
  save(s);
}

#!/usr/bin/env node
// devbridge HTTP - the same MCP over Streamable HTTP, on TWO listeners with two regimes.
//
//   LOCAL  127.0.0.1:8787  reached by this Mac and, through `tailscale serve`, by the
//                          tailnet. Bearer admin token in the header (never in the URL).
//                          Full powers: every root writable, Windows over ssh.
//   REMOTE 127.0.0.1:8788  reached ONLY by the named Cloudflare tunnel
//                          (your public hostname). OAuth 2.1 (oauth.mjs), and every call
//                          runs in the kernel sandbox (sandbox.mjs): read the projects,
//                          write only ~/devbridge-sandbox, no push, no Windows.
//
// Two ports rather than one port plus a header check: the tunnel's ingress points at
// 8788 and nothing else, so a remote request cannot claim to be local.
//
// Uso: node http.mjs [--port 8787] [--remote-port 8788] [--issuer https://<public-host>]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOAuth } from './oauth.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const PORT = Number(arg('--port', process.env.PORT || 8787));
const REMOTE_PORT = Number(arg('--remote-port', process.env.REMOTE_PORT || 8788));
// The issuer is the public https origin of the tunnel: OAuth ties every token to it, so
// there is no sensible default. run.sh reads it from config.json (`issuer`).
const ISSUER = arg('--issuer', process.env.DEVBRIDGE_ISSUER || '');
if (!ISSUER) { console.error('manca --issuer https://<host pubblico del tunnel> (o DEVBRIDGE_ISSUER)'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(os.homedir(), '.config', 'devbridge', 'token');

function token() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch {
    const t = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, t + '\n', { mode: 0o600 });
    return t;
  }
}
const TOKEN = token();

// One stdio child per regime, reused: the server is stateless per tool call. The
// remote child gets DEVBRIDGE_MODE=remote, which is what makes server.mjs sandbox
// every command and refuse writes outside ~/devbridge-sandbox.
function makeChild(mode) {
  let child = null, buf = '', nextId = 1;
  const pending = new Map();
  function ensure() {
    if (child && !child.killed) return child;
    child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, DEVBRIDGE_MODE: mode },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        } catch {}
      }
    });
    child.on('exit', () => { child = null; for (const r of pending.values()) r({ error: { code: -32000, message: 'server child terminato' } }); pending.clear(); });
    call({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `devbridge-http-${mode}`, version: '0.2.0' } } });
    return child;
  }
  function call(msg) {
    ensure();
    if (msg.id === undefined) { child.stdin.write(JSON.stringify(msg) + '\n'); return Promise.resolve(null); }
    return new Promise((resolve) => {
      pending.set(msg.id, resolve);
      child.stdin.write(JSON.stringify(msg) + '\n');
      setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'timeout' } }); } }, 600_000);
    });
  }
  return { call, nextId: () => nextId++ };
}

const oauth = createOAuth({ issuer: ISSUER, adminToken: TOKEN });

function handler({ child, remote }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // CORS only where a browser may legitimately call: the local listener. The remote
    // one is called by ChatGPT's servers, not by pages.
    const cors = remote ? {} : {
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'mcp-session-id',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (remote && await oauth.route(req, res, url)) return;
    if (url.pathname !== '/mcp') { res.writeHead(404, cors); return res.end(); }

    // The token is never read from the URL any more: a URL ends up in every log that
    // sees it. Local: the admin token as a Bearer header. Remote: an OAuth access token.
    const auth = req.headers.authorization || '';
    const ok = remote ? !!oauth.verifyAccess(auth) : safeEqual(auth, `Bearer ${TOKEN}`);
    if (!ok) {
      res.writeHead(401, {
        ...cors, 'content-type': 'application/json',
        'www-authenticate': remote ? oauth.challenge() : 'Bearer',
      });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }

    if (req.method === 'GET') { res.writeHead(405, cors); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(204, cors); return res.end(); }

    let body = '';
    req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      }
      const msgs = Array.isArray(msg) ? msg : [msg];
      const out = [];
      for (const m of msgs) {
        const id = m.id;
        const r = await child.call({ ...m, id: id === undefined ? undefined : child.nextId() });
        if (r) out.push({ ...r, id });
      }
      if (!out.length) { res.writeHead(202, cors); return res.end(); }
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'mcp-session-id': remote ? 'devbridge-remote' : 'devbridge' });
      res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    });
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

http.createServer(handler({ child: makeChild('local'), remote: false })).listen(PORT, '127.0.0.1', () => {
  console.error(`devbridge LOCAL  http://127.0.0.1:${PORT}/mcp  (Bearer admin token, poteri pieni)`);
});
http.createServer(handler({ child: makeChild('remote'), remote: true })).listen(REMOTE_PORT, '127.0.0.1', () => {
  console.error(`devbridge REMOTE http://127.0.0.1:${REMOTE_PORT}/mcp  (OAuth, sandbox) issuer ${ISSUER}`);
  // Il token non si stampa: un log e' la copia che sopravvive alla rotazione.
  console.error(`token admin in ${TOKEN_PATH} (${TOKEN.length} caratteri)`);
});

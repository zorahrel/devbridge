#!/usr/bin/env node
// devbridge HTTP - espone lo stesso MCP su Streamable HTTP, per il connettore ChatGPT.
// Autenticazione: Bearer token letto da ~/.config/devbridge/token.
// Uso: node http.mjs [--port 8787]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 8787));
const HERE = path.dirname(new URL(import.meta.url).pathname);
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

// Un solo child stdio riutilizzato: il server è stateless per tool call.
let child, buf = '', pending = new Map(), nextId = 1;
function ensureChild() {
  if (child && !child.killed) return child;
  child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  // handshake interno
  callChild({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'devbridge-http', version: '0.1.0' } } });
  return child;
}
function callChild(msg) {
  ensureChild();
  if (msg.id === undefined) { child.stdin.write(JSON.stringify(msg) + '\n'); return Promise.resolve(null); }
  return new Promise((resolve) => {
    pending.set(msg.id, resolve);
    child.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'timeout' } }); } }, 600_000);
  });
}

const srv = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'mcp-session-id',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // Token accettato in header Bearer oppure nel path (/mcp/<token>), perche il form
  // connettori di ChatGPT non permette di impostare un header custom senza OAuth.
  const url = new URL(req.url, 'http://x');
  const pathToken = url.pathname.split('/').filter(Boolean)[1] || '';
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}` && pathToken !== TOKEN) {
    res.writeHead(401, { ...cors, 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
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
      const r = await callChild({ ...m, id: id === undefined ? undefined : nextId++ });
      if (r) out.push({ ...r, id });
    }
    if (!out.length) { res.writeHead(202, cors); return res.end(); }
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'mcp-session-id': 'devbridge' });
    res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
  });
});

srv.listen(PORT, '127.0.0.1', () => {
  console.error(`devbridge http su http://127.0.0.1:${PORT}/mcp`);
  console.error(`token: ${TOKEN}`);
});

// End-to-end checks for the two listeners, OAuth and the remote sandbox.
// Runs http.mjs for real on free ports with a throwaway HOME-less config, drives it over
// HTTP exactly as ChatGPT would, and asserts what matters for safety:
//   - no token is accepted in the URL any more, on either listener;
//   - local: admin Bearer works, anything else is 401;
//   - remote: 401 carries the OAuth challenge; the full DCR + PKCE flow yields a token;
//     the consent refuses a wrong admin token; codes and refresh tokens work once;
//   - remote tools: windows_run_command is absent, writes outside the sandbox fail,
//     a push through a git alias fails, a commit inside the sandbox works.
// Usage: node test/e2e.mjs   (exit 0 = all green)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = os.homedir();
const TOKEN = fs.readFileSync(path.join(HOME, '.config', 'devbridge', 'token'), 'utf8').trim();
const SANDBOX = path.join(HOME, 'devbridge-sandbox');
// A small real repo under ~/Projects (a configured root) to clone from the sandbox.
const PROD = path.join(HOME, 'Projects', 'topics-app');

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const L = await freePort(), R = await freePort();
const ISSUER = `http://127.0.0.1:${R}`;

const proc = spawn(process.execPath, [path.join(ROOT, 'http.mjs'), '--port', String(L), '--remote-port', String(R), '--issuer', ISSUER], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; proc.stderr.on('data', (c) => { stderr += c; });
await new Promise((r) => setTimeout(r, 1200));

let failed = 0, passed = 0;
const check = (name, cond, extra = '') => { if (cond) passed++; else { failed++; console.log(`FAIL ${name} ${extra}`); } };

const rpc = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const call = async (port, auth, name, args) => {
  const r = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: auth });
  const j = await r.json(); return j.result?.content?.[0]?.text ?? JSON.stringify(j);
};

try {
  // ---- no token in the URL, anywhere
  for (const port of [L, R]) {
    const r = await fetch(`http://127.0.0.1:${port}/mcp/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    check(`token nel path rifiutato su ${port === L ? 'local' : 'remote'}`, r.status === 404 || r.status === 401, `status=${r.status}`);
  }
  // ---- local listener
  check('local senza auth 401', (await rpc(L, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 401);
  const lt = await (await rpc(L, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${TOKEN}` })).json();
  check('local con admin token vede windows_run_command', lt.result.tools.some((t) => t.name === 'windows_run_command'));

  // ---- remote: challenge and metadata
  const r401 = await rpc(R, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${TOKEN}` });
  check('remote rifiuta anche il token admin', r401.status === 401);
  check('remote 401 porta resource_metadata', /resource_metadata="/.test(r401.headers.get('www-authenticate') || ''));
  const asm = await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json();
  check('metadata: S256 e iss', asm.code_challenge_methods_supported.includes('S256') && asm.authorization_response_iss_parameter_supported === true && asm.issuer === ISSUER);

  // ---- DCR
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const reg = await (await fetch(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'e2e' }) })).json();
  check('registrazione client', !!reg.client_id);
  const badReg = await fetch(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  check('redirect http non loopback rifiutato', badReg.status === 400);

  // ---- authorize + PKCE
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${ISSUER}/mcp` };
  const page = await fetch(`${ISSUER}/oauth/authorize?${new URLSearchParams(q)}`);
  check('pagina di consenso', page.status === 200 && /Token di amministrazione/.test(await page.text()));
  const wrong = await fetch(`${ISSUER}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'allow', admin_token: 'sbagliato' }) });
  check('consenso con token sbagliato rifiutato', wrong.status === 401);
  const ok = await fetch(`${ISSUER}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'allow', admin_token: TOKEN }) });
  const loc = new URL(ok.headers.get('location'));
  check('redirect con code, state e iss', ok.status === 302 && loc.searchParams.get('code') && loc.searchParams.get('state') === 'st' && loc.searchParams.get('iss') === ISSUER);
  const code = loc.searchParams.get('code');
  const tok = (form) => fetch(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const badPkce = await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: 'x'.repeat(43) });
  check('PKCE sbagliato rifiutato', badPkce.status === 400);
  const replay = await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier });
  check('code monouso: dopo un tentativo non vale piu', replay.status === 400);

  // un code nuovo per il flusso buono
  const ok2 = await fetch(`${ISSUER}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'allow', admin_token: TOKEN }) });
  const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
  const t = await (await tok({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier })).json();
  check('token emesso', !!t.access_token && !!t.refresh_token);
  const bearer = `Bearer ${t.access_token}`;

  // refresh a rotazione
  const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: reg.client_id })).json();
  check('refresh emette un token nuovo', !!t2.access_token);
  check('refresh token monouso', (await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: reg.client_id })).status === 400);

  // ---- remote tools
  const rt = await (await rpc(R, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: bearer })).json();
  check('remote: windows_run_command assente', !rt.result.tools.some((x) => x.name === 'windows_run_command'));
  check('remote: tools presenti', rt.result.tools.some((x) => x.name === 'run_command'));

  const outside = await call(R, bearer, 'write_file', { path: path.join(HOME, 'Projects', 'topics-app', 'E2E_PROBE'), content: 'x' });
  check('remote: write_file fuori sandbox negato', /solo in/.test(outside), outside.slice(0, 120));
  check('remote: nessun file creato nella prod', !fs.existsSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_PROBE')));

  const shellOut = await call(R, bearer, 'run_command', { command: 'echo x > E2E_PROBE2', cwd: path.join(HOME, 'Projects', 'topics-app') });
  check('remote: run_command non scrive nella prod', !fs.existsSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_PROBE2')), shellOut.slice(0, 120));

  const push = await call(R, bearer, 'run_command', { command: 'git -c alias.p=push p --dry-run origin HEAD:refs/heads/e2e-probe; echo EXIT=$?', cwd: path.join(HOME, 'Projects', 'topics-app') });
  check('remote: push via alias impossibile', /EXIT=[1-9]/.test(push) && /not permitted|unable to fork|cannot exec/i.test(push), push.slice(-160));

  // A symlink planted in the sandbox must not become a door: the write path is resolved
  // through the deepest existing ancestor, so link/NEW lands on the link's target.
  const esc = path.join(SANDBOX, 'e2e-esc');
  fs.rmSync(esc, { recursive: true, force: true }); fs.mkdirSync(esc, { recursive: true });
  fs.symlinkSync(path.join(HOME, 'Projects', 'topics-app'), path.join(esc, 'link'));
  const viaLink = await call(R, bearer, 'write_file', { path: path.join(esc, 'link', 'E2E_ESCAPE', 'x.txt'), content: 'x' });
  check('remote: symlink nella sandbox non porta fuori', /solo in/.test(viaLink) && !fs.existsSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_ESCAPE')), viaLink.slice(0, 120));
  fs.rmSync(esc, { recursive: true, force: true });

  const wt = path.join(SANDBOX, 'e2e-wt');
  fs.rmSync(wt, { recursive: true, force: true });
  // The source must sit under a configured root: the sandbox reads nothing else in $HOME.
  const clone = await call(R, bearer, 'run_command', { command: `git clone -q --depth 1 file://${PROD} ${wt} && cd ${wt} && echo ok > e2e.txt && git add e2e.txt && git -c user.name=e2e -c user.email=e2e@x commit -qm e2e && git log --oneline -1`, cwd: SANDBOX });
  check('remote: clone + commit nella sandbox', /exit=0/.test(clone) && /e2e/.test(clone), clone.slice(0, 200));
  const w = await call(R, bearer, 'write_file', { path: path.join(wt, 'nota.md'), content: 'ciao' });
  check('remote: write_file nella sandbox', /scritto|ok|byte/i.test(w) || fs.existsSync(path.join(wt, 'nota.md')), w.slice(0, 120));
  fs.rmSync(wt, { recursive: true, force: true });

  // ---- escapes found by the adversarial check of 23/09: one assertion each.
  // The first profile allowed everything outside $HOME; these would all have passed.
  const sh = (command) => call(R, bearer, 'run_command', { command, cwd: SANDBOX });
  const out = (s) => (s.split('--- stdout')[1] || '').split('--- stderr')[0];
  const probes = ['/opt/homebrew/bin/devbridge-e2e-probe', '/Users/Shared/devbridge-e2e-probe', '/private/tmp/devbridge-e2e-probe'];
  await sh(probes.map((p) => `echo x > ${p}`).join('; ') + '; true');
  check('remote: niente scritture in /opt/homebrew/bin (PATH del lato locale)', !fs.existsSync(probes[0]));
  check('remote: niente scritture in /Users/Shared', !fs.existsSync(probes[1]));
  check('remote: niente scritture in /private/tmp', !fs.existsSync(probes[2]));
  const reads = await sh('for f in ~/.zsh_history ~/.gitconfig ~/.topics/daemon-state.json; do head -c1 "$f" >/dev/null 2>&1 && echo "READ $f"; done; true');
  check('remote: file fuori dai root illeggibili', !/READ /.test(out(reads)), reads.slice(0, 200));
  check('remote: env senza SSH_AUTH_SOCK', !/SSH_AUTH_SOCK/.test(out(await sh('env'))));
  const loop = await sh(`curl -s -m3 -o /dev/null -w "v4=%{http_code} " http://127.0.0.1:${L}/mcp; curl -s -m3 -o /dev/null -w "v6=%{http_code}" "http://[::1]:${L}/mcp"; true`);
  check('remote: loopback irraggiungibile (servizi locali)', /v4=000 v6=000/.test(out(loop)), out(loop));
  const agent = await sh(`python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${process.env.SSH_AUTH_SOCK || '/nonexistent'}');print('AGENT_CONNECTED')"; true`);
  check('remote: socket ssh-agent irraggiungibile', !/AGENT_CONNECTED/.test(out(agent)));
  const ae = await sh('cp /usr/bin/osascript "$TMPDIR/oa"; "$TMPDIR/oa" -e \'tell application "Finder" to get name\' 2>/dev/null && echo AE_OK; pbpaste 2>/dev/null | head -c1 | grep -q . && echo PASTE_OK; true');
  check('remote: niente Apple Events ne appunti', !/AE_OK|PASTE_OK/.test(out(ae)), out(ae).slice(0, 200));
  const kc = await sh('cp /usr/bin/security "$TMPDIR/sec"; "$TMPDIR/sec" find-generic-password -s devbridge >/dev/null 2>&1 && echo KC_OK; printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill 2>/dev/null | grep -q "^password=" && echo CRED_OK; true');
  check('remote: niente Keychain ne credential helper', !/KC_OK|CRED_OK/.test(out(kc)), out(kc).slice(0, 200));
  check('remote: niente segnali a processi fuori sandbox', !/SIGNAL_OK/.test(out(await sh(`kill -0 ${process.pid} 2>/dev/null && echo SIGNAL_OK; true`))));
  const net = await sh('curl -s -m10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad');
  check('remote: https verso internet funziona', /200/.test(out(net)), net.slice(0, 200));

  // ---- local keeps full powers
  const lw = await call(L, `Bearer ${TOKEN}`, 'run_command', { command: 'echo local-ok', cwd: path.join(HOME, 'Projects') });
  check('local: run_command normale', /local-ok/.test(lw));
} finally {
  proc.kill();
  try { fs.rmSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_PROBE'), { force: true }); fs.rmSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_PROBE2'), { force: true }); fs.rmSync(path.join(HOME, 'Projects', 'topics-app', 'E2E_ESCAPE'), { recursive: true, force: true }); } catch {}
}
console.log(`${passed} pass, ${failed} fail`);
if (/token: [A-Za-z0-9_-]{20,}/.test(stderr) || stderr.includes(TOKEN)) { console.log('FAIL il token e finito nei log'); failed++; }
process.exit(failed ? 1 : 0);

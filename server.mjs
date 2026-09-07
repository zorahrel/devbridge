#!/usr/bin/env node
// devbridge - local MCP server: gives ChatGPT read/write access to whitelisted project roots.
// stdio JSON-RPC 2.0, zero dependencies.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// PATH esplicito: il client passa un ambiente minimale e pnpm/npx non troverebbero node
const SAFE_PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.HOME}/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

// processi lunghi (dev server, suite): non stanno in un timeout, vivono oltre la singola chiamata
const jobs = new Map();
let jobSeq = 1;

const CONFIG_PATH = process.env.DEVBRIDGE_CONFIG
  || path.join(os.homedir(), '.config', 'devbridge', 'config.json');

const DEFAULT_CONFIG = {
  roots: [path.join(os.homedir(), 'Projects')],
  maxReadBytes: 400_000,
  execTimeoutMs: 180_000,
  allowExec: true,
  denyGlobs: ['**/.env', '**/.env.*', '**/id_rsa*', '**/*.pem', '**/auth.json', '**/.ssh/**'],
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return DEFAULT_CONFIG;
  }
}

let CFG = loadConfig();
const roots = () => CFG.roots.map(r => path.resolve(r.replace(/^~/, os.homedir())));

function resolveInRoot(p) {
  const abs = path.resolve(p.replace(/^~/, os.homedir()));
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  const ok = roots().some(r => {
    const rr = fs.existsSync(r) ? fs.realpathSync(r) : r;
    return real === rr || real.startsWith(rr + path.sep);
  });
  if (!ok) throw new Error(`Path fuori dai root consentiti: ${abs}\nRoot: ${roots().join(', ')}`);
  const base = path.basename(real);
  if (/^\.env(\..*)?$|^id_rsa|\.pem$|^auth\.json$/.test(base)) {
    throw new Error(`File protetto (secret), accesso negato: ${base}`);
  }
  if (real.includes(`${path.sep}.ssh${path.sep}`)) throw new Error('Accesso a .ssh negato');
  return real;
}

// ---------- tools ----------

const tools = {
  run_background: {
    description: 'Avvia un processo lungo in background (dev server, watch, suite di test) e torna subito con un id. '
      + 'Usa read_output per leggerne l output e stop_background per fermarlo. Serve per tutto cio che non finisce da solo.',
    annotations: { title: 'Avvia processo in background', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'es. "pnpm dev"' },
        cwd: { type: 'string' },
        name: { type: 'string', description: 'Nome breve per ritrovarlo, es. "dev-server"' },
      },
      required: ['command', 'cwd'],
    },
    handler: async ({ command, cwd, name }) => {
      const dir = resolveInRoot(cwd);
      const key = name || 'job' + (jobSeq++);
      if (jobs.has(key)) throw new Error(`Esiste gia un processo "${key}". Fermalo con stop_background o usa un altro nome.`);
      const out = path.join(os.tmpdir(), `devbridge-${key}-${Date.now()}.log`);
      const fd = fs.openSync(out, 'w');
      const child = spawn('/bin/bash', ['-lc', `export PATH="${SAFE_PATH}"; ${command}`], {
        cwd: dir, detached: true, stdio: ['ignore', fd, fd],
        env: { ...process.env, PATH: SAFE_PATH },
      });
      child.unref();
      jobs.set(key, { pid: child.pid, log: out, command, cwd: dir, started: Date.now() });
      await new Promise(r => setTimeout(r, 2500));
      const first = fs.readFileSync(out, 'utf8').slice(0, 1500);
      const alive = (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })();
      return `avviato "${key}" pid=${child.pid} ${alive ? '(vivo)' : '(GIA USCITO)'}\n--- primi output\n${first || '(ancora niente)'}`;
    },
  },

  read_output: {
    description: 'Legge l output di un processo avviato con run_background.',
    annotations: { title: 'Leggi output processo', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        lines: { type: 'integer', description: 'Ultime N righe, default 120' },
      },
      required: ['name'],
    },
    handler: async ({ name, lines = 120 }) => {
      const j = jobs.get(name);
      if (!j) return `Nessun processo "${name}". Attivi: ${[...jobs.keys()].join(', ') || 'nessuno'}`;
      const alive = (() => { try { process.kill(j.pid, 0); return true; } catch { return false; } })();
      const text = fs.existsSync(j.log) ? fs.readFileSync(j.log, 'utf8') : '';
      const tail = text.split('\n').slice(-lines).join('\n');
      return `"${name}" pid=${j.pid} ${alive ? 'in esecuzione' : 'TERMINATO'} da ${Math.round((Date.now() - j.started) / 1000)}s\n--- ultime ${lines} righe\n${tail.slice(-40_000)}`;
    },
  },

  stop_background: {
    description: 'Ferma un processo avviato con run_background. Senza nome, elenca quelli attivi.',
    annotations: { title: 'Ferma processo', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    handler: async ({ name }) => {
      if (!name) return [...jobs.entries()].map(([k, j]) => `${k} pid=${j.pid} ${j.command}`).join('\n') || 'nessun processo attivo';
      const j = jobs.get(name);
      if (!j) return `Nessun processo "${name}"`;
      try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
      jobs.delete(name);
      return `fermato "${name}" (pid ${j.pid})`;
    },
  },

  list_roots: {
    description: 'Elenca le cartelle di progetto a cui hai accesso. Chiamalo per primo se non sai dove sei.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Elenca cartelle di progetto', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async () => roots().map(r => `${r}${fs.existsSync(r) ? '' : '  (MANCANTE)'}`).join('\n'),
  },

  list_dir: {
    description: 'Elenca il contenuto di una directory (non ricorsivo). Mostra tipo e dimensione.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Percorso assoluto della directory' } },
      required: ['path'],
    },
    annotations: { title: 'Elenca directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ path: p }) => {
      const dir = resolveInRoot(p);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules') { out.push(`${e.name}/  (skipped)`); continue; }
        if (e.isDirectory()) out.push(`${e.name}/`);
        else {
          let size = '';
          try { size = `  ${(await fsp.stat(path.join(dir, e.name))).size}b`; } catch {}
          out.push(`${e.name}${size}`);
        }
      }
      return out.sort().join('\n') || '(vuota)';
    },
  },

  read_file: {
    description: 'Legge un file di testo. Usa offset/limit (righe) per file grandi. Restituisce righe numerate.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: 'Prima riga (1-based), default 1' },
        limit: { type: 'integer', description: 'Numero di righe, default 800' },
      },
      required: ['path'],
    },
    annotations: { title: 'Leggi file', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ path: p, offset = 1, limit = 800 }) => {
      const f = resolveInRoot(p);
      const st = await fsp.stat(f);
      if (st.size > CFG.maxReadBytes * 8) throw new Error(`File troppo grande (${st.size}b)`);
      const text = await fsp.readFile(f, 'utf8');
      const lines = text.split('\n');
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n');
      const tail = offset - 1 + limit < lines.length
        ? `\n... (${lines.length} righe totali, mostrate ${offset}-${offset + slice.length - 1})` : '';
      return body.slice(0, CFG.maxReadBytes) + tail;
    },
  },

  write_file: {
    description: 'Scrive (crea o sovrascrive) un file. Crea le directory mancanti. Per modifiche puntuali preferisci edit_file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    annotations: { title: 'Scrivi file', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async ({ path: p, content }) => {
      const f = resolveInRoot(p);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      const existed = fs.existsSync(f);
      await fsp.writeFile(f, content, 'utf8');
      return `${existed ? 'Sovrascritto' : 'Creato'}: ${f} (${Buffer.byteLength(content)} byte)`;
    },
  },

  edit_file: {
    description: 'Sostituzione esatta di stringa in un file. old_string deve comparire esattamente una volta (o usa replace_all).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    annotations: { title: 'Modifica file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async ({ path: p, old_string, new_string, replace_all = false }) => {
      const f = resolveInRoot(p);
      const text = await fsp.readFile(f, 'utf8');
      const parts = text.split(old_string);
      const n = parts.length - 1;
      if (n === 0) throw new Error('old_string non trovato. Rileggi il file: deve corrispondere carattere per carattere.');
      if (n > 1 && !replace_all) throw new Error(`old_string trovato ${n} volte. Allarga il contesto o usa replace_all.`);
      const out = replace_all ? parts.join(new_string) : text.replace(old_string, new_string);
      await fsp.writeFile(f, out, 'utf8');
      return `Modificato ${f} (${replace_all ? n : 1} sostituzione/i)`;
    },
  },

  search: {
    description: 'Cerca un pattern regex nei file (ripgrep). Restituisce file:riga:testo.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory dove cercare' },
        glob: { type: 'string', description: 'Filtro file, es. *.ts' },
        max_results: { type: 'integer' },
      },
      required: ['pattern', 'path'],
    },
    annotations: { title: 'Cerca nel codice', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ pattern, path: p, glob, max_results = 100 }) => {
      const dir = resolveInRoot(p);
      const rg = fs.existsSync('/opt/homebrew/bin/rg') ? '/opt/homebrew/bin/rg'
        : '/Applications/ChatGPT.app/Contents/Resources/rg';
      const args = ['-n', '--no-heading', '-m', String(max_results), '--max-columns', '300'];
      if (glob) args.push('-g', glob);
      args.push(pattern, dir);
      try {
        const { stdout } = await execFileP(rg, args, { maxBuffer: 8e6, timeout: 60_000 });
        return stdout.split('\n').slice(0, max_results).join('\n') || '(nessun risultato)';
      } catch (e) {
        if (e.code === 1) return '(nessun risultato)';
        throw e;
      }
    },
  },

  find_files: {
    description: 'Trova file per nome/glob dentro una directory.',
    inputSchema: {
      type: 'object',
      properties: { glob: { type: 'string', description: 'es. **/*.tsx' }, path: { type: 'string' } },
      required: ['glob', 'path'],
    },
    annotations: { title: 'Trova file', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ glob, path: p }) => {
      const dir = resolveInRoot(p);
      const rg = fs.existsSync('/opt/homebrew/bin/rg') ? '/opt/homebrew/bin/rg'
        : '/Applications/ChatGPT.app/Contents/Resources/rg';
      try {
        const { stdout } = await execFileP(rg, ['--files', '-g', glob, dir], { maxBuffer: 8e6, timeout: 60_000 });
        return stdout.split('\n').slice(0, 300).join('\n') || '(nessun file)';
      } catch (e) {
        if (e.code === 1) return '(nessun file)';
        throw e;
      }
    },
  },

  git: {
    description: 'Esegue un comando git nel repo indicato (status, diff, log, add, commit, branch...). Niente push.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory del repo' },
        args: { type: 'array', items: { type: 'string' }, description: 'es. ["status","--short"]' },
      },
      required: ['cwd', 'args'],
    },
    annotations: { title: 'Comando git', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async ({ cwd, args }) => {
      const dir = resolveInRoot(cwd);
      if (args.some(a => /^(push|remote)$/.test(a))) throw new Error('push/remote non consentiti da qui: lo fa l\'umano.');
      try {
        const { stdout, stderr } = await execFileP('/usr/bin/git', args, { cwd: dir, maxBuffer: 8e6, timeout: 120_000 });
        return (stdout + stderr).slice(0, 60_000) || '(nessun output)';
      } catch (e) {
        return `exit=${e.code}\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 60_000);
      }
    },
  },

  run_command: {
    description: 'Esegue un comando shell nel progetto (test, build, lint) e aspetta che finisca. '
      + 'Default 180s: per build o suite piu lunghe alza timeout_sec. Per cio che non finisce da solo (dev server, watch) usa run_background.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando completo, es. "pnpm test"' },
        cwd: { type: 'string' },
        timeout_sec: { type: 'integer', description: 'Timeout in secondi (default 180, max 900).' },
      },
      required: ['command', 'cwd'],
    },
    annotations: { title: 'Esegui comando', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async ({ command, cwd, timeout_sec }) => {
      if (!CFG.allowExec) throw new Error('run_command disabilitato nella config.');
      const dir = resolveInRoot(cwd);
      const env = { ...process.env, PATH: SAFE_PATH };
      try {
        const { stdout, stderr } = await execFileP('/bin/bash', ['-lc', `export PATH="${SAFE_PATH}"; ${command}`], {
          cwd: dir, env, maxBuffer: 8e6,
          timeout: Math.min((timeout_sec ? timeout_sec * 1000 : CFG.execTimeoutMs), 900_000),
        });
        return `exit=0\n--- stdout\n${stdout.slice(-30_000)}\n--- stderr\n${stderr.slice(-10_000)}`;
      } catch (e) {
        const why = e.killed || e.signal === 'SIGTERM'
          ? `TIMEOUT dopo ${Math.min((timeout_sec ? timeout_sec : CFG.execTimeoutMs / 1000), 900)}s. Rilancia con timeout_sec piu alto, o avvia in background con run_background.`
          : `exit=${e.code ?? '?'} ${e.message ? '(' + e.message.split('\n')[0].slice(0, 200) + ')' : ''}`;
        return `${why}\n--- stdout\n${(e.stdout || '').slice(-30_000)}\n--- stderr\n${(e.stderr || '').slice(-20_000)}`;
      }
    },
  },
};

// ---------- MCP protocol ----------

const SERVER_INFO = { name: 'devbridge', version: '0.1.0' };

function toolList() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    title: t.annotations?.title,
    description: t.description,
    inputSchema: t.inputSchema,
    // senza annotations il client marca ogni tool come distruttivo e chiede conferma a ogni chiamata
    annotations: t.annotations,
  }));
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      CFG = loadConfig();
      return reply({
        protocolVersion: params?.protocolVersion === '2024-11-05' ? '2024-11-05' : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'devbridge da accesso ai file locali dei progetti. Chiama list_roots per vedere le cartelle disponibili, '
          + 'poi list_dir/read_file/search per orientarti e edit_file/write_file per modificare. '
          + 'run_command per test e build. Lavora sempre con percorsi assoluti.',
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'tools/call': {
      const t = tools[params?.name];
      if (!t) return fail(`Tool sconosciuto: ${params?.name}`);
      try {
        const text = await t.handler(params.arguments || {});
        return reply({ content: [{ type: 'text', text: String(text) }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `ERRORE: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return null;
      return fail(`Metodo non supportato: ${method}`, -32601);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));

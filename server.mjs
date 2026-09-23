#!/usr/bin/env node
// devbridge - local MCP server: gives ChatGPT read/write access to whitelisted project roots.
// stdio JSON-RPC 2.0, zero dependencies.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { taskTools, load as loadTask } from './tools-task.mjs';
import { sandboxed, sandboxEnv, developerBin, remoteMayWrite, SANDBOX_ROOT } from './sandbox.mjs';

// Set by http.mjs on the child that serves the public tunnel. In remote mode every
// command runs inside the kernel sandbox and file writes are allowed only under
// SANDBOX_ROOT; see sandbox.mjs for why a rule inside a tool is not enough.
const REMOTE = process.env.DEVBRIDGE_MODE === 'remote';

const execFileP = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';

// PATH esplicito: il client passa un ambiente minimale e pnpm/npx non troverebbero node.
// Su Windows conserviamo il PATH ereditato e aggiungiamo le directory di sistema.
const SAFE_PATH = IS_WINDOWS
  ? [
      process.env.Path || process.env.PATH,
      process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32'),
      process.env.SystemRoot,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'),
    ].filter(Boolean).join(path.delimiter)
  : `/opt/homebrew/bin:/usr/local/bin:${process.env.HOME || os.homedir()}/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

// Remote: the real developer tools come before /usr/bin, whose git/python3 are xcrun shims
// that would need the owner's shared xcrun cache (see developerBin in sandbox.mjs).
const DEV_BIN = REMOTE && !IS_WINDOWS ? developerBin() : null;
const RUN_PATH = DEV_BIN ? `${DEV_BIN}:${SAFE_PATH}` : SAFE_PATH;
const GIT = DEV_BIN ? path.join(DEV_BIN, 'git') : '/usr/bin/git';

function commandEnv() {
  // Remote: nothing inherited. The parent env carries SSH_AUTH_SOCK and whatever launchd
  // gave the bridge; a sandboxed command has no business seeing either.
  if (REMOTE) return sandboxEnv(SAFE_PATH);
  const env = { ...process.env };
  env.PATH = SAFE_PATH;
  if (IS_WINDOWS) env.Path = SAFE_PATH;
  return env;
}

function shellInvocation(command) {
  if (IS_WINDOWS) {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    return { file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] };
  }
  const bash = { file: '/bin/bash', args: ['-lc', `export PATH="${RUN_PATH}"; ${command}`] };
  return REMOTE ? sandboxed(bash.file, bash.args, configRoots()) : bash;
}

/** Resolve a path the caller wants to WRITE: in remote mode only inside the sandbox. */
function resolveWritable(p) {
  const real = resolveInRoot(p);
  if (REMOTE && !remoteMayWrite(real)) {
    throw new Error(`Da remoto si scrive solo in ${SANDBOX_ROOT}. Clona o crea un worktree li' (git clone file://<progetto> ${SANDBOX_ROOT}/<nome>) e lavora sulla copia.`);
  }
  return real;
}

// processi lunghi (dev server, suite): non stanno in un timeout, vivono oltre la singola chiamata
const jobs = new Map();
let jobSeq = 1;

// The job log is opened by THIS process, which runs outside the sandbox. The caller's job
// name used to be pasted into its path: `../../Library/LaunchAgents/x` wrote a file with
// the command's output anywhere the owner can write. The name is now a label only, and
// logs live in a private 0700 directory under a server-chosen file name.
const JOB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-jobs-'));
fs.chmodSync(JOB_LOG_DIR, 0o700);
const safeJobName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64);

const CONFIG_PATH = process.env.DEVBRIDGE_CONFIG
  || path.join(os.homedir(), '.config', 'devbridge', 'config.json');

const DEFAULT_CONFIG = {
  roots: [path.join(os.homedir(), 'Projects')],
  maxReadBytes: 400_000,
  execTimeoutMs: 180_000,
  allowExec: true,
  // windowsSsh: { host, user, connectTimeoutSec } nel config.json. Il bridge resta sul Mac
  // e raggiunge il PC via SSH + PowerShell; senza config il tool lo dice e si ferma.
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
/** The configured project roots, real paths: what a remote command may READ. */
function configRoots() {
  return CFG.roots
    .map(x => path.resolve(x.replace(/^~/, os.homedir())))
    .map(r => (fs.existsSync(r) ? fs.realpathSync(r) : r));
}
const roots = () => {
  const r = CFG.roots.map(x => path.resolve(x.replace(/^~/, os.homedir())));
  return REMOTE ? [...r, SANDBOX_ROOT] : r;
};

/**
 * The real path of `abs`, even when it does not exist yet: resolve the deepest existing
 * ancestor and append the rest. Resolving only paths that exist let a remote caller write
 * THROUGH a symlink it had planted in the sandbox (link -> ~/Projects/topics-app, then
 * write_file link/NEW): the check saw a non-existent path under the sandbox and allowed
 * it, the write followed the link into prod. Found on 23/09 before shipping.
 */
function realPathDeep(abs) {
  let head = abs;
  const tail = [];
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  const base = fs.existsSync(head) ? fs.realpathSync(head) : head;
  return tail.length ? path.join(base, ...tail) : base;
}

function resolveInRoot(p) {
  const abs = path.resolve(p.replace(/^~/, os.homedir()));
  const real = realPathDeep(abs);
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

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodePowerShell(command) {
  // -EncodedCommand evita che shell locale, ssh e cmd.exe alterino quoting/newline.
  return Buffer.from(String(command), 'utf16le').toString('base64');
}

// ---------- tools ----------

const tools = {
  ...taskTools,
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
      const key = name ? safeJobName(name) : 'job' + (jobSeq++);
      if (jobs.has(key)) throw new Error(`Esiste gia un processo "${key}". Fermalo con stop_background o usa un altro nome.`);
      const out = path.join(JOB_LOG_DIR, `${jobSeq++}-${Date.now()}.log`);
      const fd = fs.openSync(out, 'w');
      const shell = shellInvocation(command);
      const child = spawn(shell.file, shell.args, {
        cwd: dir, detached: !IS_WINDOWS, stdio: ['ignore', fd, fd],
        env: commandEnv(),
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
    annotations: { title: 'Ferma processo', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    handler: async ({ name }) => {
      if (!name) return [...jobs.entries()].map(([k, j]) => `${k} pid=${j.pid} ${j.command}`).join('\n') || 'nessun processo attivo';
      const j = jobs.get(name);
      if (!j) return `Nessun processo "${name}"`;
      if (IS_WINDOWS) {
        try { await execFileP('taskkill.exe', ['/PID', String(j.pid), '/T', '/F']); } catch {}
      } else {
        try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
      }
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
    annotations: { title: 'Scrivi file', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ path: p, content }) => {
      const f = resolveWritable(p);
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
      const f = resolveWritable(p);
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

  append_file: {
    description: 'Aggiunge testo in fondo a un file (lo crea se manca). Serve per costruire un file grande '
      + 'in piu chiamate: un file da 50KB non entra in una sola risposta. Scrivi la prima parte con write_file, '
      + 'poi continua con append_file finche non e completo.',
    annotations: { title: 'Aggiungi in fondo al file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    handler: async ({ path: p, content }) => {
      const f = resolveWritable(p);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.appendFile(f, content, 'utf8');
      const st = await fsp.stat(f);
      const righe = (await fsp.readFile(f, 'utf8')).split('\n').length;
      return `aggiunti ${Buffer.byteLength(content)} byte a ${f} (ora ${st.size} byte, ${righe} righe)`;
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
        const g = REMOTE ? sandboxed(GIT, args, configRoots()) : { file: '/usr/bin/git', args };
        const opts = { cwd: dir, maxBuffer: 8e6, timeout: 120_000, ...(REMOTE ? { env: commandEnv() } : {}) };
        const { stdout, stderr } = await execFileP(g.file, g.args, opts);
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
      const env = commandEnv();
      const shell = shellInvocation(command);
      try {
        const { stdout, stderr } = await execFileP(shell.file, shell.args, {
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

  windows_run_command: {
    description: 'Esegue PowerShell sul PC Windows configurato, collegandosi via SSH dal Mac. '
      + 'Il bridge resta sul Mac: usa questo tool per audit hardware/NVIDIA, Ollama, installazione/configurazione '
      + 'nativa di JCode e benchmark sulla RTX 3090. Non usare la versione browser di JCode e non creare un bridge Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando PowerShell completo da eseguire sul Windows.' },
        remote_cwd: { type: 'string', description: 'Cartella Windows opzionale, es. C:\\Users\\zorah\\devbridge.' },
        timeout_sec: { type: 'integer', description: 'Timeout in secondi (default 180, max 900).' },
      },
      required: ['command'],
    },
    annotations: { title: 'Esegui PowerShell su Windows via Mac', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async ({ command, remote_cwd, timeout_sec }) => {
      if (!CFG.allowExec) throw new Error('Esecuzione disabilitata nella config.');
      const target = CFG.windowsSsh || {};
      if (!target.host || !target.user) {
        throw new Error('Target Windows SSH non configurato: servono windowsSsh.host e windowsSsh.user nel config del bridge Mac.');
      }
      const remoteScript = remote_cwd
        ? `Set-Location -LiteralPath ${psLiteral(remote_cwd)}\n${command}`
        : String(command);
      const args = [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${Number(target.connectTimeoutSec) || 10}`,
        `${target.user}@${target.host}`,
        'powershell.exe',
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShell(remoteScript),
      ];
      const timeoutMs = Math.min((timeout_sec ? timeout_sec * 1000 : CFG.execTimeoutMs), 900_000);
      try {
        const { stdout, stderr } = await execFileP('/usr/bin/ssh', args, {
          env: commandEnv(), maxBuffer: 8e6, timeout: timeoutMs,
        });
        return `exit=0\n--- Windows stdout\n${stdout.slice(-40_000)}\n--- Windows stderr\n${stderr.slice(-10_000)}`;
      } catch (e) {
        const why = e.killed || e.signal === 'SIGTERM'
          ? `TIMEOUT dopo ${Math.round(timeoutMs / 1000)}s`
          : `exit=${e.code ?? '?'} ${e.message ? '(' + e.message.split('\n')[0].slice(0, 200) + ')' : ''}`;
        return `${why}\n--- Windows stdout\n${(e.stdout || '').slice(-40_000)}\n--- Windows stderr\n${(e.stderr || '').slice(-20_000)}`;
      }
    },
  },
};

// ---------- MCP protocol ----------

const SERVER_INFO = { name: 'devbridge', version: '0.1.0' };

/** Tools that must not exist for a remote caller: they act outside the sandbox. */
const LOCAL_ONLY = new Set(['windows_run_command']);
const visibleTools = () => Object.entries(tools).filter(([name]) => !(REMOTE && LOCAL_ONLY.has(name)));

function toolList() {
  return visibleTools().map(([name, t]) => ({
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
      // registra cosa dichiara il client: serve per sapere se supporta elicitation/sampling
      try {
        fs.appendFileSync(path.join(os.tmpdir(), 'devbridge-init.log'),
          new Date().toISOString() + ' ' + JSON.stringify(params) + '\n');
      } catch {}
      return reply({
        protocolVersion: params?.protocolVersion === '2024-11-05' ? '2024-11-05' : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          (REMOTE
            ? 'SEI COLLEGATO DA REMOTO, IN SANDBOX. Puoi LEGGERE i progetti, ma scrivere, committare ed eseguire '
              + `solo dentro ${SANDBOX_ROOT}. Per lavorare su un progetto: git clone file://<percorso-progetto> `
              + `${SANDBOX_ROOT}/<nome>, poi modifica e testa li'. Push, ssh e Windows non sono disponibili: `
              + 'consegna il lavoro come commit nella copia in sandbox e scrivi il percorso, lo porta dentro l umano.\n\n'
            : '')
          + 'devbridge da accesso ai file locali dei progetti. list_roots per vedere le cartelle, '
          + 'list_dir/read_file/search per orientarti, edit_file/write_file per modificare, '
          + 'run_command per test e build, run_background per cio che non finisce da solo. '
          + 'Per il PC Windows e la RTX 3090 usa windows_run_command: esegue PowerShell sul Windows via SSH dal Mac. '
          + 'JCode va configurato nativo/local sul Windows, mai nella versione browser. '
          + 'Percorsi sempre assoluti.\n\n'
          + 'LAVORO SU PIU MESSAGGI. Non ricordi i turni precedenti, ma il piano su disco si. '
          + 'Chiama SEMPRE task_status come prima cosa: ti dice a che punto eri. '
          + 'Se il lavoro non sta in una risposta sola, apri task_start con obiettivo e passi, '
          + 'poi fai UN passo per volta e chiudilo con task_step_done indicando la prova. '
          + 'task_note per cio che ti servira dopo. task_done solo quando e verificato davvero. '
          + 'Quando finisci un turno con passi ancora aperti, dillo esplicitamente: il lavoro riprende da li.\n\n'
          + 'FILE GRANDI. Sopra le ~300 righe non provare a scrivere tutto in una risposta: '
          + 'apri con write_file e prosegui con append_file, un pezzo per chiamata. '
          + 'Un file troncato a meta costa piu di due chiamate in piu.',
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
      const requestedName = params?.name;
      // Alcuni connector MCP premettono il namespace dell'app al nome dell'azione.
      // Il server espone invece le azioni senza namespace: accettiamo entrambe le forme.
      const name = typeof requestedName === 'string' && requestedName.startsWith('dev_bridge.')
        ? requestedName.slice('dev_bridge.'.length)
        : requestedName;
      const t = REMOTE && LOCAL_ONLY.has(name) ? undefined : tools[name];
      if (!t) return fail(`Tool sconosciuto: ${requestedName}`);
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

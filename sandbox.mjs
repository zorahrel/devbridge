// devbridge sandbox - what a REMOTE caller (ChatGPT over the public tunnel) may touch.
//
// WHY THIS EXISTS. On the night of 12-13/09 an automation driving the bridge from ChatGPT
// checked out an unreviewed branch inside ~/Projects/topics-app, the working directory of
// the production server, and tried to push. The bridge "forbade" push in the git tool,
// but run_command is bash: `git -c alias.p=push p` went straight through. A rule the
// caller can route around is not a fence.
//
// THE FENCE. Remote calls run under macOS sandbox-exec with a profile that:
//   - denies every file write under $HOME except the sandbox root (~/devbridge-sandbox)
//     and the usual caches/temp a toolchain needs;
//   - denies reading ~/.ssh, the Keychain files, and the bridge's own secrets;
//   - denies running ssh, scp, gh, security and the git remote helpers, so nothing can
//     leave the machine with the owner's identity (no push, no clone of private repos
//     with the owner's keys). Plain outbound network stays open: installs need it, and
//     without the owner's credentials it reaches only what the public internet does.
// Read access to the project roots stays: ChatGPT can study the code, clone it into the
// sandbox with `git worktree add`/`git clone`, and work there.
//
// The kernel enforces this, whatever the command does. Verified on macOS 26.2.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const SANDBOX_ROOT = path.join(os.homedir(), 'devbridge-sandbox');

const HOME = os.homedir();

/** Writes a remote caller needs besides the sandbox: temp dirs and package caches. */
const EXTRA_WRITABLE = [
  '/private/tmp', '/private/var/folders', '/dev',
  path.join(HOME, '.npm'), path.join(HOME, '.bun', 'install', 'cache'),
  path.join(HOME, 'Library', 'Caches'), path.join(HOME, '.cache'),
  path.join(HOME, 'Library', 'pnpm'), path.join(HOME, '.local', 'share', 'pnpm'),
];

/** Never readable from a remote call, even inside the project roots. */
const SECRET_READ = [
  path.join(HOME, '.ssh'),
  path.join(HOME, 'Library', 'Keychains'),
  path.join(HOME, '.config', 'devbridge'),
  path.join(HOME, '.config', 'gh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.cloudflared'),
  path.join(HOME, '.mcp-auth'),
];

/** Programs that carry the owner's identity off the machine. */
const DENY_EXEC = [
  '/usr/bin/ssh', '/usr/bin/scp', '/usr/bin/sftp',
  '/opt/homebrew/bin/gh', '/usr/local/bin/gh',
  '/usr/bin/security',
  '/opt/homebrew/bin/cloudflared',
];

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function profile() {
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (subpath ${q(HOME)}))`,
    `(allow file-write* (subpath ${q(SANDBOX_ROOT)}))`,
    ...EXTRA_WRITABLE.map((p) => `(allow file-write* (subpath ${q(p)}))`),
    ...SECRET_READ.map((p) => `(deny file-read* (subpath ${q(p)}))`),
    ...DENY_EXEC.map((p) => `(deny process-exec (literal ${q(p)}))`),
    // git push/fetch over ssh need ssh (denied above); over https they need the
    // credential helper, which reads the Keychain (denied above). Belt and braces:
    '(deny process-exec (regex #"/git-remote-(https?|ssh)$"))',
  ];
  return lines.join('\n') + '\n';
}

let profilePath = null;
function ensureProfile() {
  if (profilePath && fs.existsSync(profilePath)) return profilePath;
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-sb-'));
  profilePath = path.join(dir, 'remote.sb');
  fs.writeFileSync(profilePath, profile(), { mode: 0o600 });
  return profilePath;
}

/** Wrap an argv so it runs inside the remote sandbox. */
export function sandboxed(file, args) {
  return { file: '/usr/bin/sandbox-exec', args: ['-f', ensureProfile(), file, ...args] };
}

/** True when a path may be WRITTEN by a remote caller (file tools, not only shell). */
export function remoteMayWrite(realPath) {
  const r = path.resolve(realPath);
  return r === SANDBOX_ROOT || r.startsWith(SANDBOX_ROOT + path.sep);
}

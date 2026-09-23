// devbridge sandbox - what a REMOTE caller (ChatGPT over the public tunnel) may touch.
//
// WHY THIS EXISTS. On the night of 12-13/09 an automation driving the bridge from ChatGPT
// checked out an unreviewed branch inside ~/Projects/topics-app, the working directory of
// the production server, and tried to push. The bridge "forbade" push in the git tool,
// but run_command is bash: `git -c alias.p=push p` went straight through. A rule the
// caller can route around is not a fence.
//
// THE FENCE. Remote calls run under macOS sandbox-exec. The first version started from
// `(allow default)` and denied writes only under $HOME: the adversarial check of 23/09
// wrote into /opt/homebrew/bin, which is first in the PATH of the unsandboxed local side,
// so one planted binary became full powers. It also found secrets readable outside a
// short deny list, the ssh-agent socket reachable, `open`/`osascript` running things
// outside the sandbox, and loopback services (OpenClaw, Topics with the token read from
// ~/.topics) one curl away. So every axis is now an allow-list:
//   - writes: nowhere but SANDBOX_ROOT (plus /dev/null and friends);
//   - reads under $HOME: only the project roots, the sandbox and the toolchains; secrets
//     by name (.env, .npmrc, keys) stay unreadable even inside the roots;
//   - network: outbound tcp 80/443 and DNS only, never loopback, never unix sockets
//     (ssh-agent, jcode, Docker): installs and git fetch over https work, local services
//     and ssh do not;
//   - mach services: an allow-list of what libc, DNS and TLS need. The Keychain
//     (securityd), the pasteboard, Apple Events and LaunchServices are not on it, so the
//     git credential helper, `security`, `pbpaste`, `osascript` and `open` all fail;
//   - signals: only to processes inside the same sandbox.
// Checked on macOS 26.2 by test/e2e.mjs, one assertion per escape above.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const SANDBOX_ROOT = path.join(os.homedir(), 'devbridge-sandbox');
/** HOME and TMPDIR of a remote command: caches and dotfiles land in the sandbox. */
export const SANDBOX_HOME = path.join(SANDBOX_ROOT, '.home');
export const SANDBOX_TMP = path.join(SANDBOX_ROOT, '.tmp');

const HOME = os.homedir();

/** Readable under $HOME besides the project roots: runtimes a build may need. */
const TOOLCHAINS = ['.bun', '.nvm', '.cargo', '.rustup', '.deno', 'Library/pnpm', '.local/share/pnpm']
  .map((p) => path.join(HOME, p));

/** Never readable, even inside a project root (same list the file tools refuse). */
const SECRET_NAMES = String.raw`/(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.toml|\.json)?|auth\.json|secrets?(\.[a-z]+)?|service-?account[^/]*\.json|[^/]*-key\.json|id_[a-z0-9]+|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|[^/]*\.key|[^/]*\.keystore)$`;

/** Programs that carry the owner's identity off the machine. Belt and braces: the mach
 *  and socket rules already cut them off, and a renamed copy would dodge a path rule. */
const DENY_EXEC = [
  '/usr/bin/ssh', '/usr/bin/scp', '/usr/bin/sftp', '/usr/bin/ssh-add',
  '/opt/homebrew/bin/gh', '/usr/local/bin/gh',
  '/usr/bin/security', '/usr/bin/osascript', '/usr/bin/open', '/bin/launchctl',
  '/opt/homebrew/bin/cloudflared',
];

/** What libc, DNS, TLS and preferences need. Anything else is refused. */
const MACH_ALLOW = [
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership',
  'com.apple.system.notification_center', 'com.apple.system.logger', 'com.apple.logd',
  'com.apple.diagnosticd', 'com.apple.analyticsd', 'com.apple.dnssd.service',
  'com.apple.mDNSResponder', 'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration', 'com.apple.networkd',
  'com.apple.nesessionmanager.flow-divert-token', 'com.apple.trustd', 'com.apple.trustd.agent',
  'com.apple.ocspd', 'com.apple.cfprefsd.daemon', 'com.apple.cfprefsd.agent',
  'com.apple.CoreServices.coreservicesd', 'com.apple.dyld.closured',
];

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where the real developer tools live. /usr/bin/git, python3, clang... are xcrun shims:
 * they cache their lookup in DARWIN_USER_TEMP_DIR/xcrun_db, a plain key->path file every
 * unsandboxed git of the owner reads back. Letting the sandbox write it (so the shim
 * works) was a code-execution hole: rewrite the `git` entry, and the owner's next git
 * runs your binary. Found by the second adversarial check of 23/09. So remote commands
 * get the real bin dir first in PATH and never touch the shim or its cache.
 */
export function developerBin() {
  try {
    const dir = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    const bin = path.join(dir, 'usr', 'bin');
    if (fs.existsSync(path.join(bin, 'git'))) return bin;
  } catch { /* no developer tools: git simply is not available remotely */ }
  return null;
}

/** The per-user temp dir: other apps' sockets and caches, never readable remotely. */
function userTempDir() {
  try {
    return fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim());
  } catch { return null; }
}

/** @param {string[]} readRoots project roots a remote caller may read (config `roots`). */
export function profile(readRoots = []) {
  const readable = [SANDBOX_ROOT, ...readRoots, ...TOOLCHAINS];
  const utmp = userTempDir();
  const lines = [
    '(version 1)',
    '(allow default)',
    // writes: the sandbox and nothing else
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(SANDBOX_ROOT)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    // reads under $HOME: allow-list
    `(deny file-read-data (subpath ${q(HOME)}))`,
    `(allow file-read-data (literal ${q(HOME)}) ${readable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // anchored to $HOME: a bare *.pem rule also hid /etc/ssl/cert.pem and broke TLS
    `(deny file-read-data (regex #"^${escRe(HOME)}/.*${SECRET_NAMES}"))`,
    // the user temp dir holds other apps' sockets and the xcrun cache: closed both ways
    ...(utmp ? [`(deny file-read-data (subpath ${q(utmp)}))`] : []),
    // network: https/http and DNS out, never loopback, never local sockets
    '(deny network-outbound)',
    '(allow network-outbound (remote tcp "*:443") (remote tcp "*:80") (remote udp "*:53") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(deny network-outbound (remote ip "localhost:*"))',
    // mach services: allow-list
    '(deny mach-lookup)',
    `(allow mach-lookup ${MACH_ALLOW.map((n) => `(global-name ${q(n)})`).join(' ')})`,
    // no signals to anything the sandbox did not start
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    ...DENY_EXEC.map((p) => `(deny process-exec (literal ${q(p)}))`),
    '(deny process-exec (regex #"/git-remote-(https?|ssh)$"))',
  ];
  return lines.join('\n') + '\n';
}

let profilePath = null;
let profileKey = null;
function ensureProfile(readRoots) {
  const key = JSON.stringify(readRoots);
  if (profilePath && profileKey === key && fs.existsSync(profilePath)) return profilePath;
  for (const d of [SANDBOX_ROOT, SANDBOX_HOME, SANDBOX_TMP]) fs.mkdirSync(d, { recursive: true });
  // The profile lives outside the sandbox: a remote command must not be able to rewrite it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-sb-'));
  profilePath = path.join(dir, 'remote.sb');
  profileKey = key;
  fs.writeFileSync(profilePath, profile(readRoots), { mode: 0o600 });
  return profilePath;
}

/** Wrap an argv so it runs inside the remote sandbox. */
export function sandboxed(file, args, readRoots = []) {
  return { file: '/usr/bin/sandbox-exec', args: ['-f', ensureProfile(readRoots), file, ...args] };
}

/** Environment of a remote command: nothing inherited (no SSH_AUTH_SOCK, no tokens). */
export function sandboxEnv(pathValue) {
  const dev = developerBin();
  return {
    PATH: dev ? `${dev}:${pathValue}` : pathValue,
    HOME: SANDBOX_HOME, TMPDIR: SANDBOX_TMP + path.sep,
    LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** True when a path may be WRITTEN by a remote caller (file tools, not only shell). */
export function remoteMayWrite(realPath) {
  const r = path.resolve(realPath);
  return r === SANDBOX_ROOT || r.startsWith(SANDBOX_ROOT + path.sep);
}

# Dev Bridge

**Give the ChatGPT chat the hands it is missing.** A local MCP server that lets the ChatGPT web
chat read, write, run and test code on your machine, over your chat quota instead of a coding
agent's.

```
ChatGPT chat  ──►  tunnel  ──►  devbridge  ──►  your files
 (the brain)                   (the hands)
```

The model already knows how to program. What it cannot do, from a browser tab, is open a file.
That is the entire gap this closes, and it is smaller than it looks.

---

## Why

Coding agents bill separately from chat. When the coding quota runs out mid-week, the chat is
still there, still capable, and completely blind to your disk. Copy-pasting files into a text box
is not a workflow.

Dev Bridge hands it nineteen tools, a persistent plan, and a fence.

## What it can actually do

Not a toy. Measured on a real monorepo (91 source files, pnpm workspaces, four TypeScript
projects, 30+ Playwright checks):

| Task | Result |
|---|---|
| Read a 3,036-line file, name the exported class and its main method | `RigDriver`, `apply(dt, active)` at line 888. Verified exact. |
| Count files importing shared modules | 9 of 10. Off by one, and it explained why: no literal `shared/...` imports, only relative paths. |
| Start a dev server, run a 136s Playwright suite against it, stop it | Passed, without touching the terminal. |
| Edit `package.json`, then prove nothing broke | `engines` added, `pnpm typecheck` exit 0. |
| Build a calculator from scratch and verify it | 461 lines, 6/6 functional tests green. |
| Build a Keplerian solar system, unattended, across three turns | 957 lines, 9/9 on an automated physics judge. Tied with a frontier model given the same brief. |

It also found a bug in this project. Investigating why a suite failed with
`WebSocket is not defined`, it traced the cause to a Node version mismatch that came from *my*
`PATH` handling. That fix is in the history.

## Install

Requires Node 20+ and a ChatGPT account with developer mode enabled.

```bash
git clone https://github.com/zorahrel/devbridge.git ~/devbridge
cd ~/devbridge
cp config.example.json ~/.config/devbridge/config.json   # list your project folders here
./run.sh                                                  # prints the URL to paste into ChatGPT
```

Paste that URL into **ChatGPT → Settings → Apps → Create app**, auth *None*. Done.

For unattended use, `install-agent.sh` sets up a launchd agent that starts everything at login and
keeps the ChatGPT app pointed at the current tunnel by itself.

## The tools

**Read** `list_roots` `list_dir` `read_file` `search` `find_files`
**Write** `write_file` `append_file` `edit_file` `git`
**Run** `run_command` `run_background` `read_output` `stop_background`
**Plan** `task_start` `task_status` `task_step_done` `task_note` `task_add_steps` `task_done`

`run_background` exists because a dev server does not fit inside a request. Long-lived processes
get detached, followed with `read_output`, and closed with `stop_background`.

## The fence

The model is a guest on your machine, not the owner.

- **Whitelisted roots only.** Everything outside the folders you list is refused, symlinks
  resolved before the check.
- **Secrets are never readable**, not even inside an allowed root: `.env*`, `*.pem`, `id_rsa*`,
  `auth.json`, anything under `.ssh/`.
- **No `git push`, no `git remote`.** Publishing stays a human decision.
- **Bearer token**, 0600 on disk. No token, no answer.
- Only `run_command` is marked destructive, so that is the only prompt you see. A confirmation
  dialog you dismiss on every single call is not a safety feature, it is furniture.

## Three things that cost a day to learn

**Creating the connector is not enough.** `POST /aip/connectors/mcp` returns 200, the app shows up
installed, and the chat still answers *"Dev Bridge is installed but exposes no usable commands."*
The missing step is `POST /aip/connectors/links/noauth` with the action names. It is what the
**Connect** button does, and it is in no documentation. Found by sniffing the UI's own traffic.

**`bash -lc` overwrites your PATH.** Passing `PATH` in the child environment does nothing: the
login shell sources your profile *after* and puts its own directories first. On this machine that
meant Node 18 instead of 25, and every suite using the global `WebSocket` died. The PATH has to be
re-exported inside the command.

**When the model says it has no tools, check your own logs first.** A task failed with *"Dev Bridge
exposes no usable commands"* and I blamed the reasoning mode. Wrong: my sync had deleted the
connector and failed to recreate it. The model was describing my bug accurately while I looked for
one in the product. An honest error message deserves an honest reading.

## Working across turns

A chat answers once and stops. But the model forgetting is not the same as the work forgetting:
the plan lives in `~/.config/devbridge/task.json`, so every turn can pick up where the last one
left off.

```bash
node loop.mjs "refactor the auth module and prove the tests still pass" --cwd ~/code/app
node loop.mjs --continua      # resume an open task
```

`task_start` opens a plan, `task_step_done` closes one step at a time with its evidence,
`task_note` keeps what the next turn will need. `loop.mjs` watches that file and writes the next
message itself while steps remain open, approving tool prompts as they appear.

Measured: a Keplerian solar system, 957 lines across three turns, nobody at the keyboard. Second
law verified numerically at 0.0% deviation from constant areal velocity.

Above ~300 lines, open with `write_file` and continue with `append_file`. 50KB does not fit in one
response, and a file truncated halfway costs more than two extra calls.

## Limits, honestly

- **Free tunnels rotate.** `trycloudflare` hands out a new hostname each boot and the connector
  API has no PATCH, so the app is deleted and recreated on every start. Automatic, but it needs a
  logged-in browser session. A custom domain removes this entirely.
- **A turn is slow.** Two to five minutes of real work each. The loop is autonomous, not fast.
- **No sandbox beyond the roots.** `run_command` runs what it is told inside them. The fence is
  the filesystem, not a VM.

## How it works

`server.mjs` is a dependency-free MCP server over stdio. `http.mjs` wraps it in Streamable HTTP so
a remote model can reach it. `sync-connector.mjs` re-registers the app after each restart, driving
the ChatGPT backend API through an authenticated browser tab.

The stdio core also installs as a desktop-app plugin, no tunnel involved, if you have coding
quota to spend.

## License

MIT.

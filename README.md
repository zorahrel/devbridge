# Dev Bridge

Server MCP locale che dà alla **chat** di ChatGPT (non a Codex) gli strumenti per lavorare sui
progetti del Mac. Nasce per usare la quota chat quando quella Codex è finita: il modello ragiona
in chat, il server esegue le operazioni sui file.

## Tool

`list_roots` · `list_dir` · `read_file` · `write_file` · `edit_file` · `search` · `find_files` ·
`git` · `run_command`

## Architettura

```
chat ChatGPT (server OpenAI) → tunnel cloudflare → http.mjs :8787 → server.mjs (stdio) → file
```

La chat gira sui server OpenAI, quindi un MCP stdio locale non la raggiunge: serve un URL HTTPS
pubblico. `server.mjs` resta il cuore stdio (usabile anche come plugin dell'app desktop);
`http.mjs` lo espone su HTTP.

## Sicurezza

- Solo le cartelle in `~/.config/devbridge/config.json` (`roots`). Fuori → errore.
- `.env`, `*.pem`, `id_rsa*`, `auth.json`, `.ssh/` negati sempre, anche dentro i root.
- `git push` e `git remote` bloccati: pubblicare resta una decisione umana.
- Token in `~/.config/devbridge/token` (0600), passato nel path (`/mcp/<token>`) perché il form
  connettori di ChatGPT non permette header custom senza OAuth. Senza token → 401.

## Uso quotidiano

Parte da solo al login (`~/Library/LaunchAgents/com.jarvis.devbridge.plist`). Niente da fare.

```bash
tail -f ~/jarvis/mcp-devbridge/logs/agent.log   # stato
cat ~/jarvis/mcp-devbridge/logs/current-url.txt # URL corrente
launchctl kickstart -k gui/501/com.jarvis.devbridge  # riavvio
```

In chat basta nominarlo: «con Dev Bridge, apri X e correggi Y».

## L'URL cambia a ogni avvio

Il tunnel gratuito `trycloudflare` assegna un hostname nuovo ogni volta, e l'API dei connettori
non ha un PATCH. `sync-connector.mjs` quindi **cancella e ricrea** l'app a ogni avvio, via API:

1. `POST /backend-api/aip/connectors/mcp` — se risponde 409, il body contiene
   `existing_connector_id`: si cancella quello e si riprova.
2. `POST /backend-api/aip/connectors/links/noauth` con `action_names` — **questo passo è
   obbligatorio**: senza il "link" l'app risulta installata ma la chat risponde «non espone
   comandi utilizzabili».

Serve Chrome sulla porta CDP 19223 con la sessione ChatGPT loggata (profilo
`~/.cache/cdp-mcp/skill-profile`): il token di sessione si legge da lì.

Per un URL stabile servirebbe un dominio su Cloudflare (`cloudflared tunnel route dns`) oppure
il tunnel nativo OpenAI, che sta su platform.openai.com ed è legato all'org API.

## File

| file | ruolo |
|---|---|
| `server.mjs` | MCP stdio, i 9 tool, la sandbox |
| `http.mjs` | transport HTTP + auth, riusa `server.mjs` come child |
| `run.sh` | avvio foreground per launchd: http + tunnel + sync |
| `sync-connector.mjs` | riallinea l'app ChatGPT all'URL corrente |
| `.codex-plugin/` | manifest per installarlo come plugin dell'app desktop |

## Nota sull'app desktop

`server.mjs` è installato anche come plugin Codex (`codex plugin list` → `devbridge@local`).
Lì funziona da subito senza tunnel, ma serve la quota **Codex**, che è il problema di partenza.
Il percorso HTTP è quello che usa la quota **chat**.

// Riallinea l'app "Dev Bridge" di ChatGPT all'URL corrente del tunnel.
// Tutto via API backend (nessuna UI): l'endpoint di creazione non ha un PATCH,
// quindi si cancella e si ricrea. Il 409 restituisce l'id esistente, che e' come
// lo ritroviamo anche quando logs/connector-id.txt e' disallineato.
// uso: node sync-connector.mjs [url]
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const url = process.argv[2] || fs.readFileSync(path.join(HERE, 'logs/current-url.txt'), 'utf8').trim();
const PORT = process.env.CDP_PORT || 19223;
const NAME = 'Dev Bridge';
const DESC = 'Legge e modifica i file dei progetti locali sul Mac';

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null))?.json?.() ?? [];
const tab = tabs.find?.(t => (t.url || '').startsWith('https://chatgpt.com'));
if (!tab) { console.error('Nessuna tab chatgpt.com su CDP :' + PORT + ' (serve Chrome loggato)'); process.exit(3); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expression) => new Promise(r => {
  const i = ++id; pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
}).then(r => r.result?.result?.value);

const result = await ev(`(async () => {
  const s = await (await fetch('/api/auth/session')).json();
  const H = {Authorization: 'Bearer ' + s.accessToken, 'content-type': 'application/json'};
  const body = {name: ${JSON.stringify(NAME)}, description: ${JSON.stringify(DESC)},
                mcp_url: ${JSON.stringify(url)}, auth_request: {type: 'NONE'}};

  const create = async () => {
    const r = await fetch('/backend-api/aip/connectors/mcp', {method:'POST', headers:H, body: JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => ({}))};
  };

  let c = await create();
  // 409 = ne esiste gia' uno con questo nome: lo cancella e riprova
  if (c.status === 409) {
    const old = c.json?.detail?.existing_connector_id;
    if (!old) return 'FAIL 409 senza id: ' + JSON.stringify(c.json).slice(0, 200);
    await fetch('/backend-api/aip/connectors/' + old, {method:'DELETE', headers:H});
    c = await create();
  }
  if (c.status >= 200 && c.status < 300) {
    // la risposta di creazione non espone sempre l'id: lo si rilegge provocando il 409
    let cid = c.json.id || c.json.connector?.id || c.json.connector_id;
    if (!cid) {
      const again = await fetch('/backend-api/aip/connectors/mcp', {method:'POST', headers:H, body: JSON.stringify(body)});
      cid = (await again.json().catch(()=>({})))?.detail?.existing_connector_id;
    }
    if (!cid) return 'OK id-sconosciuto (link non creato)';
    // creare il connettore non basta: senza un "link" i tool non compaiono nella chat.
    // E' cio' che fa il bottone Collega della UI.
    const det = await (await fetch('/backend-api/aip/connectors/' + cid, {headers:H})).json();
    const actions = (det.actions || []).map(a => a.name || a);
    const lr = await fetch('/backend-api/aip/connectors/links/noauth', {method:'POST', headers:H,
      body: JSON.stringify({connector_id: cid, name: body.name, action_names: actions})});
    if (!lr.ok) return 'PARZIALE ' + cid + ': link ' + lr.status + ' ' + (await lr.text()).slice(0,150);
    return 'OK ' + cid + ' (' + actions.length + ' tool collegati)';
  }
  return 'FAIL ' + c.status + ' ' + JSON.stringify(c.json).slice(0, 250);
})()`);

console.log(result);
if (String(result).startsWith('OK ')) {
  fs.writeFileSync(path.join(HERE, 'logs/connector-id.txt'), result.slice(3).trim() + '\n');
  process.exit(0);
}
process.exit(1);

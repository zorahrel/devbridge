// Aggiorna il base_url del connettore Dev Bridge in ChatGPT con l'URL corrente del tunnel.
// Usa la sessione Chrome CDP gia loggata (porta 19223).
// node update-connector.mjs <nuovo-url>
const PORT = process.env.CDP_PORT || 19223;
const CONNECTOR_ID = process.env.DEVBRIDGE_CONNECTOR_ID || 'asdk_app_6a9edf2109988191bd2ce8364c0f1627';
const newUrl = process.argv[2];
if (!newUrl) { console.error('uso: node update-connector.mjs <url>'); process.exit(2); }

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const tab = tabs.find(t => (t.url || '').startsWith('https://chatgpt.com'));
if (!tab) { console.error('Nessuna tab chatgpt.com su CDP :' + PORT + '. Avvia Chrome con il profilo skill-profile.'); process.exit(3); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expression) => new Promise(r => {
  const i = ++id; pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});

const script = `(async () => {
  const s = await (await fetch('/api/auth/session')).json();
  const H = {Authorization:'Bearer '+s.accessToken, 'content-type':'application/json'};
  const id = ${JSON.stringify(CONNECTOR_ID)};
  const url = ${JSON.stringify(newUrl)};
  const base = url.replace(/\\/mcp\\/.*$/, '');
  for (const [method, body] of [
    ['PATCH', {base_url: url}],
    ['PATCH', {service: base, base_url: url}],
    ['POST',  {base_url: url}],
  ]) {
    const r = await fetch('/backend-api/aip/connectors/'+id, {method, headers:H, body: JSON.stringify(body)});
    const t = (await r.text()).slice(0, 300);
    if (r.ok) return 'OK ' + method + ' -> ' + t;
    var last = method + ' ' + r.status + ' ' + t;
  }
  return 'FAIL ' + last;
})()`;

const r = await ev(script);
console.log(r.result?.result?.value ?? JSON.stringify(r.result));
process.exit(0);

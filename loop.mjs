#!/usr/bin/env node
// Loop autonomo: rilancia la chat finche' il task su disco non e' chiuso.
//
// La chat risponde una volta e si ferma. Ma il piano vive in ~/.config/devbridge/task.json,
// quindi ogni turno puo' riprendere da dove si era interrotto: questo driver guarda il file,
// e se restano passi aperti scrive da solo il messaggio successivo.
//
//   node loop.mjs "<obiettivo>" [--max-turni 12] [--cwd <path>]
//   node loop.mjs --continua            riprende un task gia' aperto
//
// Richiede Chrome con la sessione ChatGPT su CDP :19223.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = process.env.CDP_PORT || 19223;
const TASK_FILE = path.join(os.homedir(), '.config', 'devbridge', 'task.json');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const MAX_TURNS = Number(flag('--max-turni', 12));
const CWD = flag('--cwd', null);
const CONTINUE = args.includes('--continua');
const FLAGS_WITH_VALUE = new Set(['--max-turni', '--cwd']);
const GOAL = (() => {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (FLAGS_WITH_VALUE.has(args[i])) i++; continue; }
    return args[i];
  }
  return null;
})();

if (!CONTINUE && !GOAL) {
  console.error('uso: node loop.mjs "<obiettivo>" [--max-turni N] [--cwd <path>]\n     node loop.mjs --continua');
  process.exit(2);
}

const readTask = () => { try { return JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')); } catch { return null; } };
const openSteps = (t) => (t?.steps || []).filter(s => s.status === 'todo' || s.status === 'doing');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- CDP ---
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null))?.json?.() ?? [];
const tab = tabs.find?.(t => (t.url || '').startsWith('https://chatgpt.com'));
if (!tab) { console.error(`Nessuna tab chatgpt.com su CDP :${PORT}. Serve Chrome loggato.`); process.exit(3); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

// Il turno e' finito quando ricompare il pulsante di invio: mentre genera, al suo posto
// c'e' il pulsante di stop. E' l'unico segnale affidabile, il DOM dei messaggi cambia troppo.
const isGenerating = () => ev(`(()=>!!document.querySelector('button[data-testid="stop-button"]'))()`);

async function askAndWait(text, maxWaitMs = 900_000) {
  await ev(`(()=>{const e=document.querySelector('#prompt-textarea, div[contenteditable="true"]'); e.focus(); return 1})()`);
  await send('Input.insertText', { text });
  await sleep(1200);
  const sent = await ev(`(()=>{const b=document.querySelector('button[data-testid="send-button"]'); if(b){b.click(); return 1} return 0})()`);
  if (!sent) throw new Error('pulsante di invio non trovato');

  await sleep(3000);
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < maxWaitMs) {
    // una conferma aperta blocca tutto: la si concede, e' il senso di avere un loop
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/Consenti sempre|Always allow/i.test(e.innerText||'')); if(b){b.click(); return 1} return 0})()`);
    const gen = await isGenerating();
    if (gen) { quiet = 0; } else { quiet++; if (quiet >= 3) break; }
    await sleep(2000);
  }
  return Math.round((Date.now() - t0) / 1000);
}

const PROMPT_CONTINUA = 'Continua il task. Chiama task_status per vedere dove eri rimasto, '
  + 'poi lavora il prossimo passo aperto e chiudilo con task_step_done indicando la prova. '
  + 'Un passo per volta. Se scopri che ne servono altri usa task_add_steps. '
  + 'Chiudi con task_done solo quando l obiettivo e verificato davvero.';

const primo = CONTINUE
  ? PROMPT_CONTINUA
  : `Con Dev Bridge${CWD ? ` su ${CWD}` : ''}: ${GOAL}\n\n`
    + 'Apri prima un task con task_start (obiettivo e passi concreti), poi lavora il PRIMO passo '
    + 'e chiudilo con task_step_done. Non fare tutto in questo messaggio: il lavoro continua nei prossimi.';

console.log(CONTINUE ? '↻ riprendo il task aperto' : `▶ ${GOAL}`);

let turn = 0;
while (turn < MAX_TURNS) {
  turn++;
  const msg = turn === 1 ? primo : PROMPT_CONTINUA;
  process.stdout.write(`\nturno ${turn}/${MAX_TURNS} … `);
  let secs;
  try { secs = await askAndWait(msg); }
  catch (e) { console.log(`errore: ${e.message}`); break; }

  const t = readTask();
  const open = openSteps(t);
  const done = (t?.steps || []).filter(s => s.status === 'done').length;
  console.log(`${secs}s | ${done}/${t?.steps?.length ?? 0} passi chiusi${open.length ? `, prossimo: ${open[0].text.slice(0, 60)}` : ''}`);

  if (t?.done) { console.log(`\n✓ TASK CHIUSO: ${t.summary || ''}`); break; }
  if (!t?.goal) { console.log('\n⚠ nessun task aperto: il modello non ha usato task_start'); break; }
  if (!open.length) { console.log('  (nessun passo aperto, un altro turno per chiudere)'); }
  await sleep(2500);
}

const fin = readTask();
if (fin && !fin.done) {
  console.log(`\n⏹ fermato dopo ${turn} turni. ${openSteps(fin).length} passi ancora aperti.`);
  console.log('   riprendi con: node loop.mjs --continua');
}
process.exit(0);

// Piano persistente su disco: e' cio' che rende possibile un loop di piu' turni.
// Il modello non ricorda tra un turno e l'altro, ma il file si': ogni turno legge dove eravamo,
// fa UN passo, lo chiude. Il driver rilancia finche' restano passi aperti.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.config', 'devbridge');
const FILE = path.join(DIR, 'task.json');

const empty = () => ({ goal: null, cwd: null, steps: [], notes: [], done: false, started: null, updated: null });

export function load() {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return empty(); }
}
function save(t) {
  fs.mkdirSync(DIR, { recursive: true });
  t.updated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(t, null, 2));
  return t;
}

function render(t) {
  if (!t.goal) return 'Nessun task attivo. Usa task_start per aprirne uno.';
  const lines = [`OBIETTIVO: ${t.goal}`];
  if (t.cwd) lines.push(`CARTELLA: ${t.cwd}`);
  lines.push('');
  t.steps.forEach((s, i) => {
    const mark = s.status === 'done' ? '[x]' : s.status === 'failed' ? '[!]' : s.status === 'doing' ? '[>]' : '[ ]';
    lines.push(`${mark} ${i + 1}. ${s.text}${s.result ? `\n      → ${s.result}` : ''}`);
  });
  if (t.notes.length) {
    lines.push('', 'APPUNTI (quello che hai gia scoperto):');
    t.notes.forEach(n => lines.push(`  - ${n}`));
  }
  const open = t.steps.filter(s => s.status === 'todo' || s.status === 'doing');
  lines.push('');
  lines.push(t.done ? 'TASK CHIUSO.' : open.length
    ? `RESTANO ${open.length} passi. Prossimo: "${open[0].text}"`
    : 'Tutti i passi sono chiusi: chiudi il task con task_done.');
  return lines.join('\n');
}

export const taskTools = {
  task_start: {
    description: 'Apre un task di piu passi che sopravvive tra un messaggio e l altro. '
      + 'Usalo quando il lavoro non sta in una sola risposta: scrivi l obiettivo e i passi, '
      + 'poi lavorane UNO per volta chiudendolo con task_step_done. Il piano resta su disco.',
    annotations: { title: 'Apri task multi-passo', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Obiettivo in una frase, con il criterio per dirlo finito' },
        steps: { type: 'array', items: { type: 'string' }, description: 'I passi in ordine' },
        cwd: { type: 'string', description: 'Cartella del progetto' },
      },
      required: ['goal', 'steps'],
    },
    handler: async ({ goal, steps, cwd }) => {
      const t = save({ ...empty(), goal, cwd: cwd || null, started: new Date().toISOString(),
        steps: steps.map(s => ({ text: s, status: 'todo', result: null })) });
      return render(t);
    },
  },

  task_status: {
    description: 'Mostra il task in corso: obiettivo, passi fatti e da fare, appunti. '
      + 'CHIAMALO PER PRIMO a ogni messaggio, per sapere dove eri rimasto.',
    annotations: { title: 'Stato del task', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    handler: async () => render(load()),
  },

  task_step_done: {
    description: 'Chiude il passo corrente con il suo esito e restituisce il prossimo. '
      + 'Un passo per volta: e cosi che il lavoro avanza tra i turni.',
    annotations: { title: 'Chiudi passo', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Cosa hai ottenuto, con la prova (output, exit code, file)' },
        failed: { type: 'boolean', description: 'true se il passo non e riuscito' },
        step: { type: 'integer', description: 'Numero del passo (1-based). Default: il primo aperto.' },
      },
      required: ['result'],
    },
    handler: async ({ result, failed = false, step }) => {
      const t = load();
      if (!t.goal) return 'Nessun task attivo.';
      const idx = step ? step - 1 : t.steps.findIndex(s => s.status !== 'done' && s.status !== 'failed');
      if (idx < 0 || !t.steps[idx]) return 'Nessun passo aperto. Chiudi il task con task_done.';
      t.steps[idx].status = failed ? 'failed' : 'done';
      t.steps[idx].result = result.slice(0, 600);
      return render(save(t));
    },
  },

  task_note: {
    description: 'Annota una scoperta che ti servira nei passi successivi (un percorso, un comando che funziona, una causa trovata). '
      + 'Sopravvive al turno: e la tua memoria.',
    annotations: { title: 'Annota scoperta', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    handler: async ({ note }) => {
      const t = load();
      if (!t.goal) return 'Nessun task attivo.';
      t.notes.push(note.slice(0, 400));
      save(t);
      return `annotato (${t.notes.length} appunti)`;
    },
  },

  task_add_steps: {
    description: 'Aggiunge passi al piano quando scopri che ne servono altri. Il piano si adatta al lavoro, non il contrario.',
    annotations: { title: 'Aggiungi passi', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] },
    handler: async ({ steps }) => {
      const t = load();
      if (!t.goal) return 'Nessun task attivo.';
      steps.forEach(s => t.steps.push({ text: s, status: 'todo', result: null }));
      return render(save(t));
    },
  },

  task_done: {
    description: 'Chiude il task. Da chiamare SOLO quando l obiettivo e raggiunto e verificato, non quando sei stanco.',
    annotations: { title: 'Chiudi task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'Cosa hai consegnato, con la prova' } }, required: ['summary'] },
    handler: async ({ summary }) => {
      const t = load();
      if (!t.goal) return 'Nessun task attivo.';
      t.done = true;
      t.summary = summary;
      save(t);
      const open = t.steps.filter(s => s.status === 'todo' || s.status === 'doing').length;
      return `TASK CHIUSO: ${summary}${open ? `\n(attenzione: ${open} passi erano ancora aperti)` : ''}`;
    },
  },
};

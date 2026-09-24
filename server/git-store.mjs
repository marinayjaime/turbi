// Historial de puntualidad guardado en la rama «data» de GitHub (el disco de Render gratis se borra al dormir).
// Se clona al arrancar y, cada cierto tiempo, se fusiona con lo último de la rama y se sube.
// La fusión es la misma que usa GitHub Actions (mergeRecords), así que los dos pueden escribir sin pisarse.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, rm } from 'node:fs/promises';
import { mergeRecords, prune, loadStore, saveDays } from '../scripts/build-punctuality.mjs';

const run = promisify(execFile);
const BRANCH = 'data';
const IDENTITY = ['-c', 'user.name=turbi-bot', '-c', 'user.email=turbi-bot@users.noreply.github.com'];

// Nunca se escribe el token en los registros.
const hide = (msg, repo) => String(msg).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').replaceAll(repo, '<repo>');

async function git(s, ...args) {
  try {
    return (await run('git', args, { cwd: s.dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    throw new Error(hide(err.stderr || err.message, s.repo));
  }
}

export async function openStore({ dir, repo }) {
  const s = { dir, repo, daysDir: `${dir}/punctuality/days`, store: new Map() };
  try { await access(`${dir}/.git`); } catch {
    await rm(dir, { recursive: true, force: true });
    try {
      await run('git', ['clone', '--quiet', '--depth', '1', '--branch', BRANCH, repo, dir]);
    } catch (err) {
      throw new Error(`no se pudo clonar la rama ${BRANCH}: ${hide(err.stderr || err.message, repo)}`);
    }
  }
  s.store = await loadStore(s.daysDir);
  return s;
}

// Registro guardado → observación para mergeRecords (null = «no se sabe», no debe borrar un dato ya guardado).
const asObservation = r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));

// Fusiona el historial en memoria con lo último de la rama y lo sube. Devuelve { pushed, changedDays }.
export async function syncStore(s, { today, attempts = 3 }) {
  for (let i = 1; ; i++) {
    await git(s, 'fetch', '--quiet', '--depth', '1', 'origin', BRANCH);
    await git(s, 'reset', '--quiet', '--hard', 'FETCH_HEAD');
    const merged = await loadStore(s.daysDir);
    const changed = mergeRecords(merged, new Map([...s.store].map(([k, r]) => [k, asObservation(r)])));
    prune(merged, today);
    await saveDays(s.daysDir, merged, changed, today);
    s.store.clear();
    for (const [k, r] of merged) s.store.set(k, r);

    await git(s, 'add', '-A');
    const pending = (await git(s, 'status', '--porcelain')).trim();
    if (!pending) return { pushed: false, changedDays: 0 };
    await git(s, ...IDENTITY, 'commit', '--quiet', '-m', `Puntualidad (Render) ${new Date().toISOString().slice(0, 16)}Z`);
    try {
      await git(s, 'push', '--quiet', 'origin', `HEAD:${BRANCH}`);
      return { pushed: true, changedDays: changed.size };
    } catch (err) {
      // Otro proceso subió entretanto: se vuelve a fusionar sobre lo suyo.
      if (i >= attempts) throw err;
    }
  }
}

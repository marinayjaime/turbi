import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, syncStore } from '../server/git-store.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const rec = over => ({ d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '17:55', sa: '19:25', x: 0, f: ['IB1668'], ...over });

// Repositorio remoto de prueba con una rama «data» y un día guardado.
async function remote() {
  const base = await mkdtemp(join(tmpdir(), 'turbi-git-'));
  const bare = join(base, 'remote.git');
  git(base, 'init', '--quiet', '--bare', '-b', 'data', bare);
  const seed = join(base, 'seed');
  git(base, 'clone', '--quiet', bare, seed);
  git(seed, 'checkout', '--quiet', '-b', 'data');
  await mkdir(join(seed, 'punctuality/days'), { recursive: true });
  await writeFile(join(seed, 'punctuality/days/2026-09-23.json'), '[\n["2026-09-23","PMI","BCN","08:00",3,"09:00",5,0,["VY3900"]]\n]\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed');
  git(seed, 'push', '--quiet', 'origin', 'data');
  return { base, bare, seed };
}

describe('almacén del historial en la rama data', () => {
  it('clona la rama y carga el historial ya guardado', async () => {
    const { base, bare } = await remote();
    const { store } = await openStore({ dir: join(base, 'store'), repo: bare });
    expect([...store.values()].map(r => r.f[0])).toEqual(['VY3900']);
  });

  it('sube los vuelos nuevos y conserva lo que otro (GitHub Actions) subió entretanto', async () => {
    const { base, bare, seed } = await remote();
    const s = await openStore({ dir: join(base, 'store'), repo: bare });
    s.store.set('nuevo', rec({ dd: 49, ad: 45 }));

    // Entretanto, otro proceso sube otro vuelo del mismo día.
    await writeFile(join(seed, 'punctuality/days/2026-09-24.json'), '[\n["2026-09-24","PMI","MAD","07:00",0,"08:25",2,0,["UX6010"]]\n]\n');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'actions');
    git(seed, 'push', '--quiet', 'origin', 'data');

    const r = await syncStore(s, { today: '2026-09-24' });
    expect(r.pushed).toBe(true);
    const check = join(base, 'check');
    git(base, 'clone', '--quiet', '--branch', 'data', bare, check);
    const day = await readFile(join(check, 'punctuality/days/2026-09-24.json'), 'utf8');
    expect(day).toContain('IB1668');
    expect(day).toContain('UX6010');
    expect(await readFile(join(check, 'punctuality/days/2026-09-23.json'), 'utf8')).toContain('VY3900');
    expect([...s.store.values()].map(x => x.f[0]).sort()).toEqual(['IB1668', 'UX6010', 'VY3900']);
  });

  it('un dato desconocido en memoria (null) no borra el que ya estaba guardado', async () => {
    const { base, bare } = await remote();
    const s = await openStore({ dir: join(base, 'store'), repo: bare });
    s.store.set('x', { d: '2026-09-23', o: 'PMI', a: 'BCN', sd: '08:00', dd: null, sa: '09:00', ad: 7, x: 0, f: ['VY3900'] });
    await syncStore(s, { today: '2026-09-24' });
    const r = [...s.store.values()].find(v => v.f[0] === 'VY3900');
    expect(r).toMatchObject({ dd: 3, ad: 7 });
    expect(s.store.size).toBe(1);
  });

  it('sin cambios no crea commits', async () => {
    const { base, bare } = await remote();
    const s = await openStore({ dir: join(base, 'store'), repo: bare });
    const r = await syncStore(s, { today: '2026-09-24' });
    expect(r.pushed).toBe(false);
    expect(git(bare, 'rev-list', '--count', 'data').trim()).toBe('1');
  });
});

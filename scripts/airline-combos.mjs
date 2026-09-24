// Combinaciones aerolínea operadora + modelo que publica Aena ahora mismo (para buscar sus fotos reales).
// Uso: node scripts/airline-combos.mjs   → data/airline-combos.json
import { writeFileSync } from 'node:fs';
import { fetchAena } from './aena-fetch.mjs';
import { aircraftName } from '../js/plain.js';
const { entries } = await fetchAena(true);
const names = {};
for (const { row } of entries) if (row.iataCompania && row.nombreCompania) names[row.iataCompania] = row.nombreCompania;
const g = new Map();
for (const { airport, type, row } of entries) {
  if (type !== 'S') continue;
  const k = `${airport}|${row.fecha}|${row.horaProgramada}|${row.iataOtro}`;
  (g.get(k) ?? g.set(k, []).get(k)).push(row);
}
const combos = new Map(); let sure = 0, unsure = 0;
for (const rows of g.values()) {
  const explicit = rows.map(r => (r.codigosCompania ?? '').split(',')[0]).find((c, i) => c && c !== rows[i].iataCompania);
  const op = explicit ?? (rows.length === 1 ? rows[0].iataCompania : null);
  if (!op) { unsure++; continue; }
  sure++;
  const k = `${op}|${aircraftName(rows[0].tipoAeronave)}`;
  combos.set(k, (combos.get(k) ?? 0) + 1);
}
console.log('segura', sure, 'dudosa', unsure, 'combinaciones', combos.size);
const list = [...combos].sort((a, b) => b[1] - a[1]).map(([k, v]) => { const [op, model] = k.split('|'); return { op, name: names[op] ?? null, model, n: v }; });
writeFileSync('data/airline-combos.json', `${JSON.stringify(list, null, 1)}\n`);
console.log(list.slice(0, 25).map(c => `${c.op} ${c.name} · ${c.model} (${c.n})`).join('\n'));

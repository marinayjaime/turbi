import { describe, it, expect, vi } from 'vitest';
import { wantsRadar, fetchRadar, withRadar, departedText, endedNote, radarNote, ENDED_ESTIMATED } from '../js/radar.js';

const leg = over => ({ d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
const card = { status: { text: 'Ha salido · Aena no informa de la llegada a Dublín', tone: 'info' }, stale: false };

describe('cuándo pregunta la app al radar', () => {
  it('ha salido y Aena no informa de la llegada; con servicio en directo', () => {
    expect(wantsRadar(leg(), 'https://x')).toBe(true);
    expect(wantsRadar(leg({ sta: 'FLY' }), 'https://x')).toBe(false);
    expect(wantsRadar(leg({ std: 'EMB' }), 'https://x')).toBe(false);
    expect(wantsRadar(leg(), null)).toBe(false);
  });
});

describe('texto cuando Aena no publica la llegada', () => {
  it('lo dice en vez de dejar solo «Ha salido»', () => {
    expect(departedText(leg(), 'Dublín')).toBe('Ha salido · Aena no informa de la llegada a Dublín');
    expect(departedText(leg({ sa: '23:35' }), 'Dublín')).toBeNull();
  });
});

describe('aviso de vuelo terminado', () => {
  it('solo dice «ha aterrizado» si lo confirma Aena; si no, habla de la hora prevista', () => {
    expect(endedNote(leg({ sa: '19:25', sta: 'LND' }))).toBe('Este vuelo ya ha aterrizado.');
    expect(endedNote(leg())).toBe('La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.');
  });
});

describe('llegada pasada según una estimación Turbi', () => {
  it('no se redacta como hora prevista oficial', () => {
    expect(endedNote(leg(), { estimated: true })).toBe('Según la estimación de Turbi, el vuelo ya habría aterrizado: no se muestra la previsión de turbulencias.');
    expect(ENDED_ESTIMATED).toBe(endedNote(leg(), { estimated: true }));
  });
  it('si el radar confirma que sigue volando, el aviso se sustituye (sin contradicción)', () => {
    expect(radarNote({ state: 'volando' })).toBe('El radar indica que el avión sigue en el aire: la previsión de turbulencias no se muestra con el vuelo en curso.');
    expect(radarNote({ state: 'sin-datos' })).toBeNull();
    expect(radarNote(null)).toBeNull();
  });
});

describe('respuesta del radar en la ficha', () => {
  it('volando: «Volando» animado y el dato del radar', () => {
    const c = withRadar(card, { state: 'volando', callsign: 'EIN737', altM: 4808, altFt: 15775, kmh: 669, seenS: 12 });
    expect(c.status).toEqual({ text: 'Volando', tone: 'info', flying: true });
    expect(c.radar).toMatchObject({ state: 'volando', callsign: 'EIN737' });
  });
  it('sin datos o no disponible: el estado de Aena no cambia, pero se dice qué ha pasado', () => {
    expect(withRadar(card, { state: 'sin-datos', callsign: 'EIN737' })).toMatchObject({ status: card.status, radar: { state: 'sin-datos' } });
    expect(withRadar(card, { state: 'no-disponible' }).status).toBe(card.status);
    expect(withRadar(card, null)).toBe(card);
    expect(withRadar(card, { state: 'no-aplica' })).toBe(card);
  });
});

describe('consulta al servicio', () => {
  it('pide /radar/AL/N.json y, si falla, null', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ state: 'volando' }) }));
    expect(await fetchRadar('EI', '737', f, 'https://live')).toEqual({ state: 'volando' });
    expect(f.mock.calls[0][0]).toBe('https://live/radar/EI/737.json');
    expect(await fetchRadar('EI', '737', vi.fn(async () => { throw new TypeError('x'); }), 'https://live')).toBeNull();
  });
});

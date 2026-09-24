// Descarga de Aena Infovuelos, compartida por GitHub Actions (build-flights) y el proceso de Render (server/live.mjs).
export const AIRPORTS = [
  'MAD', 'BCN', 'PMI', 'AGP', 'ALC', 'LPA', 'TFS', 'IBZ', 'TFN', 'VLC', 'SVQ', 'BIO', 'ACE', 'FUE', 'MAH',
  'SCQ', 'GRO', 'REU', 'XRY', 'VGO', 'OVD', 'SDR', 'LEI', 'RMU', 'GRX', 'ZAZ', 'SPC', 'VIT', 'PNA', 'GMZ',
  'VDE', 'EAS', 'LCG', 'MLN', 'JCU', 'ODB', 'HSK', 'RJL', 'LEN', 'SLM', 'VLL', 'RGS', 'BJZ',
];
const AENA = 'https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

export const madridDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offsetDays * 86400000));

export function pickMode() {
  const m = process.env.MODE ?? 'auto';
  if (m !== 'auto') return m;
  const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  const now = new Date();
  // Los 14 días completos solo en la primera ejecución de las horas múltiplo de 6; el resto, hoy y mañana.
  const fullSlot = now.getUTCHours() % 6 === 0 && now.getUTCMinutes() < 15;
  return scheduled && !fullSlot ? 'live' : 'full';
}

// Aena a veces responde con un cuerpo roto; se reintenta con esperas crecientes.
export async function fetchJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}

export async function fetchAena(twoDays) {
  const jobs = AIRPORTS.flatMap(airport => ['S', 'L'].map(type => ({ airport, type })));
  const entries = [];
  const failed = [];
  const worker = async () => {
    while (jobs.length) {
      const { airport, type } = jobs.shift();
      const url = `${AENA}&airport=${airport}&flightType=${type}${twoDays ? '&dosDias=si' : ''}`;
      try {
        const rows = await fetchJson(url);
        if (Array.isArray(rows)) for (const row of rows) entries.push({ airport, type, row });
      } catch (err) {
        failed.push({ airport, type });
        console.warn(`Aena ${airport} ${type}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`Aena: ${entries.length} filas, ${failed.length} fallos de ${AIRPORTS.length * 2}`);
  return { entries, failed };
}


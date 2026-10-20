// Capturador de scripts/capturas.sh: Chrome sin interfaz controlado por el protocolo de DevTools (sin dependencias:
// fetch y WebSocket de Node). Hace falta porque `--window-size` no baja de 500 px de ancho en Chrome de escritorio:
// para ver la ficha a 390 px (iPhone) se emula el dispositivo (ancho, alto, 2× y móvil) con Emulation.
// Uso: node scripts/capturas.mjs <chrome> <url-base> <carpeta> nombre|ancho|alto|query …
// La captura es de la página entera (captureBeyondViewport) con el viewport del alto pedido: 100dvh y el centrado de
// las pantallas se comportan como en un iPhone de ese alto, y la ficha se ve completa.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chrome, base, out, ...jobs] = process.argv.slice(2);
const profile = await mkdtemp(join(tmpdir(), 'turbi-chrome-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  // Chrome escribe el puerto elegido en DevToolsActivePort.
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(t => t.split('\n')[0]).catch(() => null);
    if (!port) await sleep(100);
  }
  if (!port) throw new Error('Chrome no ha abierto el puerto de DevTools');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

  for (const job of jobs) {
    const [name, w, h, query] = job.split('|');
    const width = Number(w), height = Number(h);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    await send('Page.navigate', { url: `${base}/scripts/muestras.html?${query}` });
    // La muestra marca data-listo al terminar de pintar; después, un margen para imágenes y fuentes.
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.readyState === 'complete' && document.documentElement.hasAttribute('data-listo')").catch(() => false)) break;
      await sleep(100);
    }
    await sleep(600);
    const full = await evaluate('Math.max(document.documentElement.scrollHeight, innerHeight)');
    // Nada debe desbordar en horizontal (spec §11: 320 px incluido): se avisa con el elemento más ancho.
    const wide = await evaluate(`document.documentElement.scrollWidth > innerWidth
      ? [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5)
        .map(e => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '')).slice(0, 5).join(', ')
      : ''`);
    if (wide) console.warn(`AVISO ${name}: desborda en horizontal (${wide})`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: full, scale: 1 } });
    const file = join(out, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    console.log(file);
  }
  ws.close();
} finally {
  proc.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true });
}

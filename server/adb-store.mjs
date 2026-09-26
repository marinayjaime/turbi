// Caché persistente de AeroDataBox en la rama «data» de GitHub (API Contents), para que el máximo de consultas por
// vuelo + fecha se cumpla aunque Render se duerma o se reinicie. Solo se guardan datos normalizados: nunca claves,
// cabeceras ni URLs. Token: GITHUB_CACHE_TOKEN (grano fino, solo «Contents: read and write» de este repositorio).
//
// Conflictos (GitHub): cada escritura es un commit sobre la punta de la rama.
//   - 409: la rama avanzó mientras tanto (u otro «sha» del archivo). 422: el archivo ya existe y no se dio «sha» — o
//     cualquier otra petición inválida: un 422 nunca se da por «archivo existente» sin comprobarlo.
//   - Ante 409 o 422 se relee SIEMPRE el archivo objetivo: si ya existe, manda lo guardado; si no existe y fue un 409
//     (la rama avanzó), se vuelve a intentar sobre la punta actual (la API la toma en cada petición). Máximo 3 intentos.

const API = 'https://api.github.com';
export const MAX_ATTEMPTS = 3;

export class StoreError extends Error {}

// Operaciones de alto nivel sobre un «put» de bajo nivel que devuelve { status, sha }.
function withConflicts(get, rawPut) {
  return {
    get,
    // Escribe lo que devuelva next(actual) — actual = null si el archivo no existe; next devuelve null para quedarse con lo
    // guardado — y devuelve lo que queda guardado. Crear es update sobre un archivo que no existe.
    async update(path, next) {
      let cur = await get(path);
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        const data = next(cur?.data ?? null);
        if (data === null) return cur?.data ?? null;
        const r = await rawPut(path, data, cur?.sha);
        if (r.status === 200 || r.status === 201) return data;
        if (r.status !== 409 && r.status !== 422) throw new StoreError(`GitHub ${r.status}`);
        const before = cur;
        cur = await get(path); // se relee siempre el archivo objetivo
        // 422 sin que el archivo haya aparecido ni cambiado: petición inválida, no un conflicto → no se insiste.
        if (r.status === 422 && !cur === !before && cur?.sha === before?.sha) throw new StoreError('GitHub 422');
      }
      throw new StoreError(`GitHub: ${MAX_ATTEMPTS} conflictos seguidos`);
    },
  };
}

export function createGithubStore({ token, repo = 'marinayjaime/turbi', branch = 'data', fetchFn = fetch, timeoutMs = 10000 }) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'turbi-live' };
  const url = path => `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  async function get(path) {
    const res = await fetchFn(`${url(path)}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new StoreError(`GitHub ${res.status}`);
    const body = await res.json();
    return { data: JSON.parse(Buffer.from(body.content ?? '', 'base64').toString('utf8')), sha: body.sha };
  }
  async function rawPut(path, data, sha) {
    const res = await fetchFn(url(path), {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ message: `AeroDataBox: ${path}`, branch, content: Buffer.from(JSON.stringify(data)).toString('base64'), ...(sha ? { sha } : {}) }),
    });
    return { status: res.status };
  }
  return withConflicts(get, rawPut);
}

// Para pruebas y desarrollo local: la misma semántica que GitHub en memoria, incluida la punta de la rama. Una escritura
// lee la punta al empezar y la confirma al terminar (tras `delay`): si otra escritura avanzó la rama entre medias,
// responde 409 como GitHub. Crear un archivo existente sin «sha» → 422; «sha» antiguo → 409.
export function createMemoryStore(initial = {}, { delay = null } = {}) {
  const files = new Map(Object.entries(initial).map(([p, data], i) => [p, { data: structuredClone(data), sha: `s${i}` }]));
  let head = 0, n = files.size;
  const puts = [];
  async function get(path) { const f = files.get(path); return f ? { data: structuredClone(f.data), sha: f.sha } : null; }
  async function rawPut(path, data, sha) {
    const start = head;
    if (delay) await delay();
    puts.push(path);
    if (head !== start) return { status: 409 }; // la rama avanzó mientras tanto
    const cur = files.get(path);
    if (cur && !sha) return { status: 422 };
    if (sha && cur?.sha !== sha) return { status: 409 };
    files.set(path, { data: structuredClone(data), sha: `s${++n}` });
    head++;
    return { status: 201 };
  }
  return { files, puts, ...withConflicts(get, rawPut) };
}

// Caché persistente de AeroDataBox en la rama «data» de GitHub (API Contents), para que el máximo de consultas por
// vuelo + fecha se cumpla aunque Render se duerma o se reinicie. Solo se guardan datos normalizados: nunca claves,
// cabeceras ni URLs. Token: GITHUB_CACHE_TOKEN (grano fino, solo «Contents: read and write» de este repositorio).
//
// Escritura segura ante concurrencia: crear sin «sha» falla si el archivo ya existe (GitHub responde 422) y actualizar
// con un «sha» antiguo falla (409): en ambos casos devuelve { ok: false, conflict: true } y quien llama relee.

const API = 'https://api.github.com';

export function createGithubStore({ token, repo = 'marinayjaime/turbi', branch = 'data', fetchFn = fetch, timeoutMs = 10000 }) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'turbi-live' };
  const url = path => `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async get(path) {
      const res = await fetchFn(`${url(path)}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const body = await res.json();
      return { data: JSON.parse(Buffer.from(body.content ?? '', 'base64').toString('utf8')), sha: body.sha };
    },
    async put(path, data, sha) {
      const res = await fetchFn(url(path), {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ message: `AeroDataBox: ${path}`, branch, content: Buffer.from(JSON.stringify(data)).toString('base64'), ...(sha ? { sha } : {}) }),
      });
      if (res.status === 409 || res.status === 422) return { ok: false, conflict: true };
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      return { ok: true, sha: (await res.json())?.content?.sha };
    },
  };
}

// Para pruebas y desarrollo local: la misma semántica en memoria.
export function createMemoryStore(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, data], i) => [p, { data, sha: `s${i}` }]));
  let n = files.size;
  return {
    files,
    async get(path) { const f = files.get(path); return f ? { data: structuredClone(f.data), sha: f.sha } : null; },
    async put(path, data, sha) {
      const cur = files.get(path);
      if ((cur && cur.sha !== sha) || (!cur && sha)) return { ok: false, conflict: true };
      const next = { data: structuredClone(data), sha: `s${++n}` };
      files.set(path, next);
      return { ok: true, sha: next.sha };
    },
  };
}

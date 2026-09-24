const KEY = 'turbi.history';
const MAX = 5;

export function loadHistory(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function saveToHistory(entry, storage = globalThis.localStorage) {
  try {
    const list = loadHistory(storage).filter(e => e.id !== entry.id);
    list.unshift(entry);
    storage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // almacenamiento no disponible (modo privado): el historial es opcional
  }
}

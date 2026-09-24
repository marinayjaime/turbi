const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const MAX_LOOKUPS = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function placeName(lat, lon, fetchFn) {
  try {
    const params = new URLSearchParams({
      lat: lat.toFixed(3), lon: lon.toFixed(3), format: 'jsonv2', zoom: '5', 'accept-language': 'es',
    });
    const res = await fetchFn(`${NOMINATIM}?${params}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    const a = json.address ?? {};
    return a.state || a.region || a.country || json.name || null;
  } catch {
    return null;
  }
}

export async function nameSegments(segments, originIata, fetchFn = fetch, wait = sleep) {
  const bumpy = segments.filter(s => s.level > 0);
  for (const [i, s] of bumpy.entries()) {
    let name = null;
    if (i < MAX_LOOKUPS) {
      if (i > 0) await wait(1100);
      name = await placeName(s.mid.lat, s.mid.lon, fetchFn);
    }
    s.place = name ? `sobre ${name}` : `a ${Math.round(s.mid.kmFromOrigin)} km de ${originIata}`;
  }
  return segments;
}

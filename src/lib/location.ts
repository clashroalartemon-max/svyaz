/** Геолокация в сообщении: `[geo]55.7558,37.6173`. */
export const GEO_PREFIX = '[geo]';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function encodeLocation(lat: number, lng: number): string {
  return `${GEO_PREFIX}${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function parseLocation(text: string): GeoPoint | null {
  if (!text.startsWith(GEO_PREFIX)) return null;
  const [latRaw, lngRaw] = text.slice(GEO_PREFIX.length).split(',');
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function mapUrl(point: GeoPoint): string {
  return `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=15/${point.lat}/${point.lng}`;
}

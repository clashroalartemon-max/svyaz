import { describe, expect, it } from 'vitest';
import { encodeLocation, mapUrl, parseLocation } from './location';

describe('геолокация', () => {
  it('кодирует и разбирает координаты', () => {
    const text = encodeLocation(55.7558, 37.6173);
    expect(parseLocation(text)).toEqual({ lat: 55.7558, lng: 37.6173 });
    expect(mapUrl({ lat: 55.7558, lng: 37.6173 })).toContain('openstreetmap.org');
  });

  it('обычный текст и битые координаты не считаются точкой', () => {
    expect(parseLocation('привет')).toBeNull();
    expect(parseLocation('[geo]100,200')).toBeNull();
    expect(parseLocation('[geo]abc,def')).toBeNull();
  });
});

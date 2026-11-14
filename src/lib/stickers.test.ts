import { describe, expect, it } from 'vitest';
import { isSticker, stickerEmoji, toSticker } from './stickers';

describe('стикеры', () => {
  it('упаковывает и распознаёт эмодзи', () => {
    const packed = toSticker('🔥');
    expect(isSticker(packed)).toBe(true);
    expect(stickerEmoji(packed)).toBe('🔥');
  });

  it('обычный текст стикером не считается', () => {
    expect(isSticker('привет')).toBe(false);
    expect(stickerEmoji('привет')).toBe('');
    expect(isSticker('[sticker]')).toBe(false);
  });
});

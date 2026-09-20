import { describe, it, expect } from 'vitest';
import { extractExif } from '../src/core/exif.js';

describe('extractExif', () => {
  it('never throws, even for bytes that are not a recognisable image', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await extractExif(junk);
    expect(result).toHaveProperty('exif');
    expect(result).toHaveProperty('error');
  });

  it('returns a null exif with no error for a well-formed image lacking EXIF data', async () => {
    // Minimal 1x1 PNG: no EXIF segment, but not malformed either.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(Buffer.from(pngBase64, 'base64'));

    const result = await extractExif(bytes);
    expect(result.error).toBeNull();
  });
});

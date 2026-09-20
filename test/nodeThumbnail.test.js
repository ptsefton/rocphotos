import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { generateThumbnail } from '../src/adapters/nodeThumbnail.js';

async function syntheticJpeg(width, height) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  }).jpeg().toBuffer();
  return new Uint8Array(buffer);
}

describe('generateThumbnail (Node/sharp)', () => {
  it('resizes a landscape image so its longest edge fits within maxSize', async () => {
    const source = await syntheticJpeg(800, 600);
    const thumb = await generateThumbnail(source, { maxSize: 200 });

    const meta = await sharp(Buffer.from(thumb)).metadata();
    expect(meta.format).toEqual('jpeg');
    expect(meta.width).toEqual(200);
    expect(meta.height).toEqual(150);
  });

  it('does not enlarge an image already smaller than maxSize', async () => {
    const source = await syntheticJpeg(100, 80);
    const thumb = await generateThumbnail(source, { maxSize: 400 });

    const meta = await sharp(Buffer.from(thumb)).metadata();
    expect(meta.width).toEqual(100);
    expect(meta.height).toEqual(80);
  });

  it('rejects bytes that are not a decodable image, so the caller can fall back gracefully', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(generateThumbnail(junk)).rejects.toThrow();
  });
});

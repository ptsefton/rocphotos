import sharp from 'sharp';

/**
 * Generates a thumbnail from image bytes using sharp (libvips). Node-only:
 * this is the CLI's counterpart to src/adapters/browserThumbnail.js, which
 * uses the browser's Canvas API instead. Not every format the application
 * accepts as an image is necessarily supported by the installed libvips
 * build (for example, some JPEG 2000 or HEIC variants); callers should
 * expect this to occasionally reject and treat that as "no thumbnail
 * available" rather than a fatal error.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {number} [options.maxSize] longest edge, in pixels
 * @param {number} [options.quality] JPEG quality, 0-100
 * @returns {Promise<Uint8Array>} JPEG-encoded thumbnail bytes
 */
export async function generateThumbnail(bytes, { maxSize = 400, quality = 80 } = {}) {
  const buffer = await sharp(bytes)
    .rotate() // apply EXIF orientation before resizing, since the thumbnail carries no EXIF of its own
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(buffer);
}

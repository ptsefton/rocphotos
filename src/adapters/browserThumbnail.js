/**
 * Generates a thumbnail from image bytes using the browser's Canvas API.
 * Browser-only: relies on `createImageBitmap` and `OffscreenCanvas`, so
 * this module is not used by the Node.js CLI or the test suite.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {number} [options.maxSize] longest edge, in pixels
 * @param {number} [options.quality] JPEG quality, 0-1
 * @returns {Promise<Uint8Array>} JPEG-encoded thumbnail bytes
 */
export async function generateThumbnail(bytes, { maxSize = 400, quality = 0.8 } = {}) {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await thumbBlob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

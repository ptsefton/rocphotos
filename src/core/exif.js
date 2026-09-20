import exifr from 'exifr';

const { parse } = exifr;

const EXIF_FIELDS = [
  'Make', 'Model', 'DateTimeOriginal', 'ImageWidth', 'ImageHeight', 'Orientation',
  'LensMake', 'LensModel',
];

/**
 * Extracts a small set of EXIF fields from image bytes. A missing or empty
 * EXIF segment (common for formats such as PNG) is not an error. Only a
 * thrown parsing failure (malformed EXIF data) is reported as an error, per
 * the application's requirement to still add the image to the crate and
 * record the problem in its description.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{exif: object|null, error: string|null}>}
 */
export async function extractExif(bytes) {
  try {
    const tags = await parse(bytes, EXIF_FIELDS);
    return { exif: tags ?? null, error: null };
  } catch (err) {
    return { exif: null, error: `EXIF extraction failed: ${err.message}` };
  }
}

// Maps exifr's own Orientation strings (see
// node_modules/exifr/src/dicts/tiff-ifd0-values.mjs) to the standard
// EXIF 1-8 orientation codes.
const ORIENTATION_CODES = {
  'Horizontal (normal)': 1,
  'Mirror horizontal': 2,
  'Rotate 180': 3,
  'Mirror vertical': 4,
  'Mirror horizontal and rotate 270 CW': 5,
  'Rotate 90 CW': 6,
  'Mirror horizontal and rotate 90 CW': 7,
  'Rotate 270 CW': 8,
};

/**
 * Converts an MWG region's Area (fractional, center-based — see
 * Spec.md) from the frame it was measured against into the frame a
 * browser <img> element actually decodes and measures pixels in.
 *
 * A browser auto-rotates a JPEG's pixels per its EXIF Orientation tag
 * when decoding it (naturalWidth/naturalHeight already reflect this),
 * but confirmed empirically against a real digiKam-tagged file (see the
 * live verification in this feature's history) that digiKam's own
 * RegionInfo.Area is measured against the image's raw, un-rotated pixel
 * grid regardless of what its own AppliedToDimensions claims — a
 * mismatch that otherwise crops entirely the wrong part of the photo.
 * The eight cases below are the standard EXIF orientation transforms;
 * only "Rotate 270 CW" has been checked against a real file so far, so
 * this is worth re-verifying against other tools/orientations if a
 * confirmation ever looks wrong for one of them.
 *
 * @param {{x:number,y:number,w:number,h:number}} area
 * @param {string|undefined} orientation - exifr's own Orientation string
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function correctAreaForOrientation(area, orientation) {
  const { x, y, w, h } = area;
  switch (ORIENTATION_CODES[orientation] ?? 1) {
    case 2: return { x: 1 - x, y, w, h };
    case 3: return { x: 1 - x, y: 1 - y, w, h };
    case 4: return { x, y: 1 - y, w, h };
    case 5: return { x: y, y: x, w: h, h: w };
    case 6: return { x: 1 - y, y: x, w: h, h: w };
    case 7: return { x: 1 - y, y: 1 - x, w: h, h: w };
    case 8: return { x: y, y: 1 - x, w: h, h: w };
    default: return { x, y, w, h };
  }
}

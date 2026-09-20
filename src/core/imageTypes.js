// Single source of truth for which file extensions are treated as images,
// and what media type each maps to (used by the SQLite index's files
// table). Keeping both concerns on one map avoids the two lists drifting
// apart.
const IMAGE_MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.jp2': 'image/jp2',
};

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

export function isImageFile(fileName) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, extensionOf(fileName));
}

export function mediaTypeFor(fileName) {
  return IMAGE_MEDIA_TYPES[extensionOf(fileName)] ?? 'application/octet-stream';
}

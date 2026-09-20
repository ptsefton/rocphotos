const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff',
  '.heic', '.heif', '.webp', '.bmp', '.jp2',
]);

export function isImageFile(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

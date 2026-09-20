// The application's own generated thumbnail cache directory. It sits
// directly inside a crate directory once created. Shared in one place
// because both the walker (to exclude it from being mistaken for source
// images) and every scan path (to name and locate thumbnail files) need to
// agree on it.
export const THUMBNAILS_DIR_NAME = 'thumbnails';

/**
 * The path, relative to a crate directory, at which the thumbnail for a
 * given source image (also relative to that crate directory) is stored.
 *
 * @param {string} imagePath
 * @returns {string}
 */
export function thumbnailPathFor(imagePath) {
  return `${THUMBNAILS_DIR_NAME}/${imagePath}.thumb.jpg`;
}

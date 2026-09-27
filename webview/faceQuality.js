// Quality gates for "find new faces" detections (webview/app.js's own
// detectFacesForImage) — deliberately never applied to backfilling an
// embedding for a region a human already named (computeEmbeddingForKnownRegion
// in app.js): there, a low-quality detection is still worth keeping,
// since the alternative is no embedding for that Person at all, not a
// better one. Here, a bad candidate is the thing causing wrong
// suggestions in the first place, so it is worth dropping before it is
// ever compared against the reference set at all.
//
// Three real, recurring sources of a bad candidate: face-api's own
// detector accepting a low-confidence non-face (a bun, a shadow) at its
// 0.5 default; a face too small to embed reliably; and a side-on/
// strongly turned face, which face-api's recognition net (trained
// mostly on frontal faces) embeds much less reliably. A plain, DOM-free
// module (unlike most of webview/, which assumes a real page) so these
// can be unit-tested directly.

export const DETECTION_MIN_CONFIDENCE = 0.7;
export const MIN_FACE_SIZE_PX = 40;
// A perfectly frontal face has the nose sitting almost exactly between
// the two eyes horizontally — this is that symmetry as a 0-1 ratio
// (1 = perfectly centred, 0 = the nose sits right under one eye, the
// hallmark of a strong profile turn). 0.5 is a conservative cutoff,
// chosen to reject a clear side-on turn while still allowing the mild,
// everyday head tilt an ordinary snapshot has; tune against real
// results rather than treating this as exact.
export const MIN_FRONTAL_RATIO = 0.5;

function averageX(points) {
  return points.reduce((sum, p) => sum + p.x, 0) / points.length;
}

/**
 * See MIN_FRONTAL_RATIO above. Agnostic to which eye is which (face-api's
 * "left"/"right" eye naming is the pictured person's own, not the
 * viewer's), since only the two nose-to-eye distances are compared.
 *
 * @param {{getNose: () => Array<{x: number}>, getLeftEye: () => Array<{x: number}>, getRightEye: () => Array<{x: number}>}} landmarks - a face-api.js FaceLandmarks68
 * @returns {number}
 */
export function frontalRatio(landmarks) {
  const noseX = averageX(landmarks.getNose());
  const leftDist = Math.abs(noseX - averageX(landmarks.getLeftEye()));
  const rightDist = Math.abs(noseX - averageX(landmarks.getRightEye()));
  const smaller = Math.min(leftDist, rightDist);
  const larger = Math.max(leftDist, rightDist);
  return larger === 0 ? 1 : smaller / larger;
}

/**
 * @param {{detection: {box: {width: number, height: number}}, landmarks: object}} result - one face-api.js detectAllFaces().withFaceLandmarks() result
 * @returns {boolean}
 */
export function isReliableForMatching(result) {
  const { width, height } = result.detection.box;
  if (width < MIN_FACE_SIZE_PX || height < MIN_FACE_SIZE_PX) return false;
  if (frontalRatio(result.landmarks) < MIN_FRONTAL_RATIO) return false;
  return true;
}

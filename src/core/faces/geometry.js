// Fractional top-left boxes ({x, y, w, h}, face-api.js's own convention —
// see Spec.md's Face Recognition section) — distinct from MWG's own
// center-based Area convention, which is converted to this shape via
// centerAreaToTopLeftBox before comparing.

/**
 * Converts an MWG region's Area (center-based, fractional — see
 * Spec.md) to the same fractional top-left shape face-api.js's own
 * detection box uses, so the two can be compared directly (see
 * boxOverlapRatio).
 *
 * @param {{x: number, y: number, w: number, h: number}} area
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function centerAreaToTopLeftBox(area) {
  return { x: area.x - area.w / 2, y: area.y - area.h / 2, w: area.w, h: area.h };
}

/**
 * Intersection-over-union of two fractional top-left boxes — 0 for no
 * overlap, 1 for identical boxes. Used to tell whether a newly detected
 * face is really the same physical face as an already-tagged region,
 * regardless of the two boxes not lining up pixel-for-pixel (a fresh
 * face-api.js detection and a human- or previously-machine-drawn MWG
 * region rarely agree exactly).
 *
 * @param {{x: number, y: number, w: number, h: number}} boxA
 * @param {{x: number, y: number, w: number, h: number}} boxB
 * @returns {number}
 */
export function boxOverlapRatio(boxA, boxB) {
  const ix1 = Math.max(boxA.x, boxB.x);
  const iy1 = Math.max(boxA.y, boxB.y);
  const ix2 = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
  const iy2 = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
  const intersectionW = Math.max(0, ix2 - ix1);
  const intersectionH = Math.max(0, iy2 - iy1);
  const intersection = intersectionW * intersectionH;
  if (intersection === 0) return 0;
  const union = boxA.w * boxA.h + boxB.w * boxB.h - intersection;
  return intersection / union;
}

/**
 * Like boxOverlapRatio, but measures overlap relative to the SMALLER of
 * the two boxes rather than their union — always >= boxOverlapRatio for
 * the same pair, so a threshold on this one accepts everything a plain
 * IoU threshold would, plus more. Needed because different tools draw a
 * face box at genuinely different scales for the very same face, not
 * just a different position: confirmed against a real file where
 * face-api.js's own detection was well-centered on a digiKam-tagged
 * region but roughly half its linear size (a tight box around facial
 * features vs. one including more of the head) — plain IoU scored this
 * real match at ~0.10, comfortably below any reasonable "same face"
 * threshold, while this measure correctly scores it around 0.36 (most
 * of the smaller, detected box sits inside the tagged one).
 *
 * @param {{x: number, y: number, w: number, h: number}} boxA
 * @param {{x: number, y: number, w: number, h: number}} boxB
 * @returns {number}
 */
export function containmentOverlapRatio(boxA, boxB) {
  const ix1 = Math.max(boxA.x, boxB.x);
  const iy1 = Math.max(boxA.y, boxB.y);
  const ix2 = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
  const iy2 = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
  const intersectionW = Math.max(0, ix2 - ix1);
  const intersectionH = Math.max(0, iy2 - iy1);
  const intersection = intersectionW * intersectionH;
  if (intersection === 0) return 0;
  const smallerArea = Math.min(boxA.w * boxA.h, boxB.w * boxB.h);
  return intersection / smallerArea;
}

// Two boxes at or above this much containment overlap (see
// containmentOverlapRatio) are treated as the same physical face — an
// MWG region's box and a fresh face-api.js detection of the same face
// are drawn by two different, disagreeing methods (different position
// *and* different scale) and rarely align tightly; a real false
// positive here (two different people's faces overlapping this much)
// would need them to be right next to each other in frame.
export const SAME_FACE_OVERLAP_THRESHOLD = 0.3;

/**
 * The best containment overlap (see containmentOverlapRatio) between a
 * detected box and an MWG region's Area, trying both the raw and the
 * orientation-corrected form of that Area (both center-based — see
 * centerAreaToTopLeftBox) and taking whichever one actually lines up.
 * Different tools disagree about which frame an Area is measured
 * against for the very same Orientation value — confirmed against two
 * real files: one (digiKam) needed correcting, another (Apple Photos)
 * did not, and correcting it moved the box somewhere else in the photo
 * entirely, breaking the very check this exists for (recognising a
 * freshly detected face as one already tagged). Rather than guess which
 * convention a given file's author used, both are always tried.
 *
 * @param {{x: number, y: number, w: number, h: number}} detectedBox - fractional top-left, e.g. face-api.js's own box
 * @param {{x: number, y: number, w: number, h: number}} rawArea - the MWG region's Area exactly as read from the file, center-based
 * @param {{x: number, y: number, w: number, h: number}} correctedArea - the same Area after orientation correction (see orientation.js)
 * @returns {number}
 */
export function bestOverlapEitherOrientation(detectedBox, rawArea, correctedArea) {
  return Math.max(
    containmentOverlapRatio(detectedBox, centerAreaToTopLeftBox(rawArea)),
    containmentOverlapRatio(detectedBox, centerAreaToTopLeftBox(correctedArea)),
  );
}

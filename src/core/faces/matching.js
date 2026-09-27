// face-api.js's own FaceMatcher uses 0.6 as its default same-person
// distance threshold on the 128-d descriptor it produces. Tightened here
// to 0.5: confirmed against a real collection that 0.6 let through
// enough wrong suggestions (including, e.g., a child matched to an
// unrelated adult) to make "Confirm all" risky — a real match is missed
// less often than a wrong one is proposed, and a missed match just
// falls to "Unidentified" for manual review, while a wrong one risks
// being rubber-stamped.
export const MATCH_THRESHOLD = 0.5;

// A real match should be a clear winner among distinct identities, not
// a coin flip: if the runner-up (the closest reference belonging to a
// *different* person, or a different "stranger" bucket) is within this
// much of the best candidate's own distance, the two are too close to
// call and findClosestReference below returns null rather than guessing
// — better to leave a genuinely ambiguous face pending for a human than
// present a confident-looking suggestion that is a coin flip.
export const MATCH_MARGIN = 0.075;

/**
 * Euclidean distance between two embedding vectors — smaller means more
 * similar. Both vectors must be the same length and from the same model
 * (see MODEL_NAME/MODEL_VERSION); comparing embeddings from different
 * model versions is meaningless and must never happen.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * The closest reference face to `embedding`, if any is within
 * MATCH_THRESHOLD *and* clearly closer than the nearest reference
 * belonging to a different identity (MATCH_MARGIN) — used both to
 * suggest a Person for a fresh detection and to check a "stranger"
 * (person_id-less) reference, which suppresses a suggestion the same
 * way a real match narrows it to one.
 *
 * Several reference embeddings can belong to the same person (more
 * confirmations over time); those never count against each other here
 * — only the closest reference from each *other* personId (every
 * stranger reference, personId null, is treated as one such "other"
 * identity, since which specific stranger it is never changes the
 * outcome) competes with the best match for the margin check.
 *
 * @param {number[]} embedding
 * @param {Array<{id: string, personId: string|null, personName: string|null, embedding: number[]}>} referenceFaces
 * @returns {{reference: object, distance: number}|null}
 */
export function findClosestReference(embedding, referenceFaces) {
  const withinThreshold = referenceFaces
    .map((reference) => ({ reference, distance: euclideanDistance(embedding, reference.embedding) }))
    .filter(({ distance }) => distance <= MATCH_THRESHOLD)
    .sort((a, b) => a.distance - b.distance);

  if (withinThreshold.length === 0) return null;

  const best = withinThreshold[0];
  const runnerUp = withinThreshold.find(({ reference }) => reference.personId !== best.reference.personId);
  if (runnerUp && runnerUp.distance - best.distance < MATCH_MARGIN) {
    return null;
  }
  return best;
}

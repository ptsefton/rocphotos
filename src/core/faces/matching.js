// face-api.js's own FaceMatcher uses 0.6 as its default same-person
// distance threshold on the 128-d descriptor it produces; reused here
// rather than inventing a new number, since it is what the model was
// evaluated against.
export const MATCH_THRESHOLD = 0.6;

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
 * MATCH_THRESHOLD — used both to suggest a Person for a fresh detection
 * and to check a "stranger" (person_id-less) reference, which suppresses
 * a suggestion the same way a real match narrows it to one.
 *
 * @param {number[]} embedding
 * @param {Array<{id: string, personId: string|null, personName: string|null, embedding: number[]}>} referenceFaces
 * @returns {{reference: object, distance: number}|null}
 */
export function findClosestReference(embedding, referenceFaces) {
  let best = null;
  for (const reference of referenceFaces) {
    const distance = euclideanDistance(embedding, reference.embedding);
    if (distance <= MATCH_THRESHOLD && (!best || distance < best.distance)) {
      best = { reference, distance };
    }
  }
  return best;
}

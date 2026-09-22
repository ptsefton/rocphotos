// A single-user, local app never needs more than one writer to a crate
// file active at a time — but two independent HTTP requests (two face
// confirmations sent in quick succession, or one for a photo in the same
// directory as another still in flight) can still genuinely interleave:
// each write is itself a multi-step read-modify-write (read the crate or
// photo file, mutate it in memory, write the whole thing back) with real
// I/O awaits in between, so two of them can easily overlap in time. Left
// unserialized, whichever one finishes writing last simply overwrites
// whatever the other had just written, silently discarding it — this is
// exactly what a real user's collection showed happening: confirming two
// people in the same folder in quick succession leaves only one of them
// actually saved, and the "loser" resurfaces as unidentified on the next
// run.
//
// This queues every write through one shared chain, so the whole process
// only ever has one crate-writing operation in flight at a time, no
// matter which handler it comes from (AROCAPI's own /edit/* routes, or
// the faces handler's /confirm) or how close together the requests for
// it arrive.
let queue = Promise.resolve();

/**
 * Runs `fn` only once every previously queued write has settled
 * (succeeded or failed) and returns its result — including its error, if
 * it throws, so a caller's own error handling still works normally.
 * Guarantees no two calls queued this way ever run concurrently, and run
 * in the order they were queued.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serializeWrites(fn) {
  const result = queue.then(fn, fn);
  // The shared chain itself must never become a rejected promise (that
  // would make every later call jump straight to its own rejection
  // branch without ever running `fn`) — this only tracks "has the
  // previous turn finished", not what it resolved with.
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

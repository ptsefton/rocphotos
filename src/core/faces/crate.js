import { loadOrCreateCrate, serializeCrate, setDatasetName } from '../crateBuilder.js';
import { joinPath } from '../pathUtils.js';
import { ROCPHOTOS_DIR_NAME } from '../trash.js';

// A dedicated crate for reference face embeddings, separate from the
// photo crates (see Spec.md's Face Recognition section): it holds
// application bookkeeping, not photo metadata, so it lives under the
// app's own housekeeping directory rather than being mixed into the
// collection's own ro-crate-metadata.json files. The faces-index.sqlite
// companion index (faces/store.js) is what the app actually queries;
// this crate exists so the reference set can be inspected as plain
// RO-Crate JSON-LD, the same as everything else this app manages.
export const FACES_DIR_NAME = joinPath(ROCPHOTOS_DIR_NAME, 'faces');
export const FACES_CRATE_FILE_NAME = joinPath(FACES_DIR_NAME, 'ro-crate-metadata.json');

/**
 * @param {import('../fsAdapter.js').FsAdapter} fsAdapter
 * @returns {Promise<import('ro-crate').ROCrate>}
 */
export async function loadOrCreateFacesCrate(fsAdapter) {
  const existingJson = (await fsAdapter.exists(FACES_CRATE_FILE_NAME))
    ? new TextDecoder().decode(await fsAdapter.readFile(FACES_CRATE_FILE_NAME))
    : null;
  const crate = loadOrCreateCrate(existingJson);
  setDatasetName(crate, 'Face recognition reference data');
  return crate;
}

/**
 * @param {import('../fsAdapter.js').FsAdapter} fsAdapter
 * @param {import('ro-crate').ROCrate} crate
 */
export async function saveFacesCrate(fsAdapter, crate) {
  await fsAdapter.writeFile(FACES_CRATE_FILE_NAME, serializeCrate(crate));
}

/**
 * Mirrors one reference_faces row (see faces/store.js) into the crate as
 * its own entity, purely for inspectability — the SQLite index, not this
 * crate, is what matching actually queries. `about` links to the Person
 * entity for a confirmed reference, and is omitted entirely for a
 * "stranger" (permanently-ignored, unnamed) reference.
 *
 * @param {import('ro-crate').ROCrate} crate
 * @param {object} options
 * @param {string} options.id
 * @param {string|null} options.personId
 * @param {string|null} options.personName
 * @param {string} options.sourceRegionId
 * @param {string} options.sourceImageId
 * @param {number[]} options.embedding
 * @param {string} options.modelName
 * @param {string} options.modelVersion
 */
export function addReferenceFaceEntity(crate, {
  id, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion,
}) {
  const entity = {
    '@id': id,
    '@type': 'FaceEmbedding',
    name: personName ?? 'Ignored stranger',
    sourceRegion: sourceRegionId,
    sourceImage: sourceImageId,
    embedding,
    embeddingModel: modelName,
    embeddingModelVersion: modelVersion,
  };
  if (personId) {
    entity.about = { '@id': personId };
  }
  crate.addEntity(entity, { replace: true });
  crate.addValues(crate.rootId, 'hasPart', { '@id': id });
}

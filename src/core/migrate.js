import { CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, repointReferences } from './crateBuilder.js';
import { joinPath } from './pathUtils.js';
import { loadConfig, loadExcludedDirectoryPatterns, compileNamePatternMatcher } from './config.js';

/**
 * One-off sweeps that rewrite crate JSON-LD across a whole collection.
 *
 * These exist because the data model has changed under collections that
 * already hold thousands of crates, including real ones. A scan only
 * rewrites an image whose file actually changed, so an old shape can
 * otherwise sit in a collection indefinitely, and `--reprocess` is a
 * blunt instrument: it re-reads every photo and regenerates every
 * thumbnail to fix something that is purely a question of how the JSON
 * is arranged.
 *
 * A migration reads and writes crate files and nothing else. No photo is
 * opened, no thumbnail is made, and the index is untouched — what these
 * change is not indexed, and anything that were would be a reason to run
 * a scan afterwards rather than to fold it in here.
 *
 * Each one is named, listed in `rocphotos.config.json` under
 * `migrations`, and expected to be deleted once every collection that
 * matters has been through it. They are written to be safe to run twice:
 * a second pass over an already-migrated crate finds nothing to do and
 * reports zero changes, so there is no state recording which have run.
 */

const PROXY_TYPES = new Set(['Person', 'Pet']);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function idOf(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' ? first['@id'] : undefined;
}

function firstString(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/**
 * Collapses the indirection that used to sit between a crate and the
 * people in it: a `#person-<Slug>`/`#pet-<Slug>` instance per subject
 * per crate, and a `#...-body` proxy per standoff region, each holding
 * nothing but a `prov:specializationOf` pointer at the real identity.
 * Both are now written only where they carry something of their own
 * (see crateBuilder.js's addSubjectIdentity), so in an older crate they
 * are pure noise standing between every reference and its subject.
 *
 * References are repointed at the identity the proxy specialized, then
 * the proxy is deleted. The identity itself is never deleted, and is
 * created from the proxy's own name if this crate somehow lacks it.
 *
 * **An instance whose name differs from its identity's is kept.** Under
 * the current model that is a deliberate statement — this part of the
 * collection knows them by another name — and collapsing it would throw
 * away the only record of it. Nothing wrote such a thing automatically,
 * so finding one means somebody meant it; the count is reported so it
 * does not pass unnoticed.
 */
function collapsePersonProxies(crate) {
  const changes = { instances: 0, bodies: 0, keptLocalNames: [] };

  for (const entity of [...crate.entities()]) {
    const id = entity['@id'];
    const types = asArray(entity['@type']);
    if (!types.some((type) => PROXY_TYPES.has(type))) continue;

    const identityId = idOf(entity['prov:specializationOf']);
    if (!identityId || identityId === id) continue;

    const isRegionBody = id.endsWith('-body');
    const isInstance = /^#(person|pet)-/.test(id);
    if (!isRegionBody && !isInstance) continue;

    const identity = crate.getEntity(identityId);
    const proxyName = firstString(entity.name);
    if (isInstance && proxyName && identity && firstString(identity.name) && proxyName !== firstString(identity.name)) {
      changes.keptLocalNames.push({ id, name: proxyName, identity: identityId });
      continue;
    }

    // The identity has to be in this crate for the repointed references
    // to resolve — it always is in practice, since the same call wrote
    // both, but a hand-edited crate need not be.
    if (!identity) {
      crate.addEntity({ '@id': identityId, '@type': types[0], ...(proxyName ? { name: proxyName } : {}) });
    }

    repointReferences(crate, id, identityId);
    crate.deleteEntity(id);
    if (isRegionBody) changes.bodies += 1;
    else changes.instances += 1;
  }

  return changes;
}

/**
 * Removes `mentions` from the crate's root dataset.
 *
 * Every Person, Pet and relationship used to be listed there so that it
 * was linked from the root dataset rather than left unreferenced. That
 * is not required — a contextual entity nothing points at is fine — and
 * the list was one more thing every write had to keep in step. Nothing
 * writes it now.
 *
 * Only the property goes. The entities it listed are left exactly as
 * they are.
 */
function removeRootMentions(crate) {
  const mentions = asArray(crate.rootDataset.mentions);
  if (crate.rootDataset.mentions === undefined) return { mentions: 0 };
  crate.deleteProperty(crate.rootId, 'mentions');
  return { mentions: mentions.length };
}

function contextTerms(context) {
  const terms = new Set();
  for (const part of asArray(context)) {
    if (part && typeof part === 'object') Object.keys(part).forEach((term) => terms.add(term));
  }
  return terms;
}

/**
 * Writes the current `@context` into a crate that predates it.
 *
 * Every crate binds the `rocphotos:` terms (`ImageRegion`,
 * `FaceEmbedding`, `regionType` and the rest), `oa` and `rico` — see
 * loadOrCreateCrate, which adds whichever are missing each time a crate
 * is loaded. But that only reaches the file when something rewrites the
 * crate, and a scan rewrites only what changed. A crate nothing has
 * touched since still has the bare schema.org context on disk, where a
 * bare `FaceEmbedding` falls through `@vocab` to a schema.org IRI that
 * does not exist, and so does not validate against the profile.
 *
 * Loading has already done the work; all this has to do is notice that
 * the file on disk lacks terms the loaded crate has, and say so. The
 * graph itself is not changed.
 */
function refreshContext(crate, { source, markChanged }) {
  const onDisk = contextTerms(source?.['@context']);
  const missing = [...contextTerms(crate.toJSON()['@context'])].filter((term) => !onDisk.has(term));
  if (missing.length === 0) return { crates: 0, terms: 0 };
  markChanged();
  return { crates: 1, terms: missing.length };
}

/**
 * The migrations this version knows about, in the order they run.
 * `description` is what the Settings screen shows beside each one.
 */
export const MIGRATIONS = [
  {
    name: 'collapse-person-proxies',
    description: 'Point photos and regions straight at each person, removing the per-crate instance and region-body nodes that used to stand in between.',
    apply: collapsePersonProxies,
  },
  {
    name: 'remove-root-mentions',
    description: 'Remove the list of every person, pet and relationship from each crate\'s root dataset. The entries themselves are kept.',
    apply: removeRootMentions,
  },
  {
    name: 'refresh-context',
    description: 'Add the current term definitions to the @context of crates written before they existed, so their types and properties resolve as the profile expects.',
    apply: refreshContext,
  },
];

export const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

/**
 * The migrations a collection has asked for, from `rocphotos.config.json`:
 *
 * ```json
 * { "migrations": ["collapse-person-proxies"] }
 * ```
 *
 * The default is none. A migration rewrites every crate in the
 * collection, so running one has to be something somebody chose, not
 * something that happens because they upgraded.
 *
 * @param {object} config - as loadConfig returns it
 * @returns {{selected: Array<object>, unknown: string[]}}
 */
export function selectMigrations(config, only = null) {
  const asked = only ?? (Array.isArray(config?.migrations) ? config.migrations : []);
  const names = new Set(asked.map((name) => String(name).trim()).filter(Boolean));
  return {
    selected: MIGRATIONS.filter((migration) => names.has(migration.name)),
    unknown: [...names].filter((name) => !MIGRATION_NAMES.includes(name)),
  };
}

/**
 * Every `ro-crate-metadata.json` in the collection, root first.
 *
 * Found by walking the directory tree rather than by reading the index,
 * unlike regeneratePreviews: a collection needing a migration may well
 * have no index yet, or one that does not list a crate the migration
 * still has to fix. Honours the collection's own excluded-directory
 * patterns so a migration never descends somewhere a scan would not.
 */
async function findCrateFiles(fsAdapter, isExcludedDir, dirPath = '') {
  const found = [];
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) found.push({ dirPath, cratePath });

  for (const entry of await fsAdapter.readDir(dirPath)) {
    if (!entry.isDirectory || isExcludedDir(entry.name)) continue;
    found.push(...(await findCrateFiles(fsAdapter, isExcludedDir, joinPath(dirPath, entry.name))));
  }
  return found;
}

/**
 * Applies the selected migrations to every crate in the collection.
 *
 * A crate is written back only when a migration actually changed
 * something, so a second run over a migrated collection touches no
 * files at all, and `dryRun` reports what would change without writing
 * anything. "Changed" is judged against the crate as loaded, which is
 * not quite the file: loading fills in the `@context` (see
 * loadOrCreateCrate). A migration that cares about that difference is
 * handed the file's own JSON as `source`, and calls `markChanged` to
 * have the crate written even though the loaded graph is as it was.
 *
 * One crate that cannot be read or parsed is reported and skipped
 * rather than aborting the sweep, the same way scanCollection treats a
 * corrupt crate: a collection of several thousand should not be left
 * half-migrated by one bad file.
 *
 * @param {object} deps
 * @param {import('./fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {string[]|null} [deps.only] - migration names, overriding the config
 * @param {boolean} [deps.dryRun]
 * @param {(progress: {done: number, total: number, path: string}) => void} [deps.onProgress]
 * @param {object} [deps.config] - already-loaded config, if the caller has one
 * @returns {Promise<{ran: string[], unknown: string[], cratesScanned: number, cratesChanged: number, changes: object, failed: Array<{path: string, message: string}>, dryRun: boolean}>}
 */
export async function runMigrations({ fsAdapter, only = null, dryRun = false, onProgress = null, config = null }) {
  const { selected, unknown } = selectMigrations(config ?? (await loadConfig(fsAdapter)), only);
  const result = {
    ran: selected.map((migration) => migration.name),
    unknown,
    cratesScanned: 0,
    cratesChanged: 0,
    changes: {},
    failed: [],
    dryRun,
  };
  if (selected.length === 0) return result;

  const isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  const crateFiles = await findCrateFiles(fsAdapter, isExcludedDir);

  for (const [index, { dirPath, cratePath }] of crateFiles.entries()) {
    result.cratesScanned += 1;
    onProgress?.({ done: index + 1, total: crateFiles.length, path: dirPath || '.' });

    let crate;
    let source;
    try {
      const text = new TextDecoder().decode(await fsAdapter.readFile(cratePath));
      source = JSON.parse(text);
      crate = loadOrCreateCrate(text);
    } catch (err) {
      result.failed.push({ path: cratePath, message: err.message });
      continue;
    }

    const before = serializeCrate(crate);
    let marked = false;
    const markChanged = () => { marked = true; };
    for (const migration of selected) {
      const changes = migration.apply(crate, { source, markChanged }) ?? {};
      const totals = (result.changes[migration.name] ??= {});
      for (const [key, value] of Object.entries(changes)) {
        if (Array.isArray(value)) (totals[key] ??= []).push(...value.map((item) => ({ ...item, crate: dirPath || '.' })));
        else totals[key] = (totals[key] ?? 0) + value;
      }
    }

    const after = serializeCrate(crate);
    if (after === before && !marked) continue;
    result.cratesChanged += 1;
    if (!dryRun) await fsAdapter.writeFile(cratePath, after);
  }

  return result;
}

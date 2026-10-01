import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { runMigrations, selectMigrations, MIGRATION_NAMES } from '../src/core/migrate.js';
import { loadOrCreateCrate, readImageRecord, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { personEntityId, petEntityId } from '../src/core/db/store.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

const JANE = personEntityId('Jane Smith');
const REX = petEntityId('Rex');

// A crate in the shape rocphotos wrote before references named the
// identity directly: an instance per subject, and a body proxy per
// standoff region.
function oldShapeCrate() {
  return JSON.stringify({
    '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
      { '@id': './', '@type': 'Dataset', name: '2005', hasPart: [{ '@id': 'a.jpg' }, { '@id': 'b.jpg' }] },

      { '@id': JANE, '@type': 'Person', name: 'Jane Smith' },
      { '@id': '#person-JaneSmith', '@type': 'Person', name: 'Jane Smith', 'prov:specializationOf': { '@id': JANE } },
      { '@id': REX, '@type': 'Pet', name: 'Rex' },
      { '@id': '#pet-Rex', '@type': 'Pet', name: 'Rex', 'prov:specializationOf': { '@id': REX } },

      {
        '@id': 'a.jpg', '@type': 'ImageObject', name: 'a.jpg', title: 'a.jpg',
        about: [{ '@id': '#person-JaneSmith' }, { '@id': '#pet-Rex' }],
        regions: [{ '@id': 'a.jpg#region-0' }],
      },
      {
        '@id': 'a.jpg#region-0', '@type': 'ImageRegion', name: 'Jane Smith', regionType: 'Face',
        about: { '@id': '#person-JaneSmith' }, xPosition: 0.5, yPosition: 0.5, width: 0.2, height: 0.2,
      },

      {
        '@id': 'b.jpg', '@type': 'ImageObject', name: 'b.jpg', title: 'b.jpg',
        about: [{ '@id': '#person-JaneSmith' }],
        regions: [{ '@id': 'b.jpg#region-standoff-0' }],
      },
      {
        '@id': 'b.jpg#region-standoff-0', '@type': ['ImageRegion', 'oa:Annotation'], name: 'Jane Smith', regionType: 'Face',
        'oa:hasBody': { '@id': 'b.jpg#region-standoff-0-body' },
        'oa:hasTarget': { '@id': 'b.jpg#xywh=percent:10,10,10,10' },
        writtenToFile: false,
      },
      { '@id': 'b.jpg#region-standoff-0-body', '@type': 'Person', 'prov:specializationOf': { '@id': '#person-JaneSmith' } },
    ],
  });
}

async function migrate(tree, options = {}) {
  currentRoot = await createFixtureTree(tree);
  const fsAdapter = createNodeFsAdapter(currentRoot);
  const result = await runMigrations({ fsAdapter, only: ['collapse-person-proxies'], ...options });
  const read = async (path) => loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(path)));
  return { result, read, fsAdapter };
}

describe('selectMigrations', () => {
  it('runs nothing unless the collection asked for it', () => {
    expect(selectMigrations({}).selected).toEqual([]);
    expect(selectMigrations({ migrations: [] }).selected).toEqual([]);
  });

  it('reports a name it does not know, rather than silently doing nothing', () => {
    const { selected, unknown } = selectMigrations({ migrations: ['collapse-person-proxies', 'tidy-everything'] });
    expect(selected.map((m) => m.name)).toEqual(['collapse-person-proxies']);
    expect(unknown).toEqual(['tidy-everything']);
  });

  it('takes an explicit list over the config, for a one-off run', () => {
    expect(selectMigrations({ migrations: [] }, MIGRATION_NAMES).selected.map((m) => m.name)).toEqual(MIGRATION_NAMES);
  });
});

describe('collapse-person-proxies', () => {
  it('points photos and regions straight at the person, and removes the nodes in between', async () => {
    const { result, read } = await migrate({ 'ro-crate-metadata.json': oldShapeCrate() });

    expect(result.cratesChanged).toEqual(1);
    expect(result.changes['collapse-person-proxies']).toMatchObject({ instances: 2, bodies: 1 });

    const crate = await read(CRATE_FILE_NAME);
    expect(crate.getEntity('a.jpg').about.map((ref) => ref['@id']).sort()).toEqual([JANE, REX].sort());
    expect(crate.getEntity('a.jpg#region-0').about[0]['@id']).toEqual(JANE);
    expect(crate.getEntity('b.jpg#region-standoff-0')['oa:hasBody'][0]['@id']).toEqual(JANE);

    expect(crate.getEntity('#person-JaneSmith')).toBeUndefined();
    expect(crate.getEntity('#pet-Rex')).toBeUndefined();
    expect(crate.getEntity('b.jpg#region-standoff-0-body')).toBeUndefined();

    // The identities themselves survive, which is the whole point.
    expect(crate.getEntity(JANE).name).toEqual(['Jane Smith']);
    expect(crate.getEntity(REX)['@type']).toEqual(['Pet']);
  });

  it('leaves what every reader sees unchanged', async () => {
    const { read } = await migrate({ 'ro-crate-metadata.json': oldShapeCrate() });
    const crate = await read(CRATE_FILE_NAME);

    expect(readImageRecord(crate, 'a.jpg').people).toEqual(['Jane Smith']);
    expect(readImageRecord(crate, 'a.jpg').pets).toEqual(['Rex']);
    expect(readImageRecord(crate, 'b.jpg').people).toEqual(['Jane Smith']);
  });

  it('keeps an instance whose name differs, which is a deliberate local name', async () => {
    // Nothing writes this automatically, so finding one means somebody
    // meant it — collapsing it would destroy the only record that this
    // part of the collection knew her by another name.
    const crate = JSON.parse(oldShapeCrate());
    crate['@graph'].find((e) => e['@id'] === '#person-JaneSmith').name = 'Janey';
    const { result, read } = await migrate({ 'ro-crate-metadata.json': JSON.stringify(crate) });

    const migrated = await read(CRATE_FILE_NAME);
    expect(migrated.getEntity('#person-JaneSmith')).toBeTruthy();
    expect(migrated.getEntity('a.jpg').about.map((ref) => ref['@id'])).toContain('#person-JaneSmith');
    expect(result.changes['collapse-person-proxies'].keptLocalNames).toEqual([
      { id: '#person-JaneSmith', name: 'Janey', identity: JANE, crate: '.' },
    ]);
  });

  it('does not reference the identity twice where a photo named both shapes', async () => {
    const crate = JSON.parse(oldShapeCrate());
    crate['@graph'].find((e) => e['@id'] === 'a.jpg').about = [{ '@id': '#person-JaneSmith' }, { '@id': JANE }];
    const { read } = await migrate({ 'ro-crate-metadata.json': JSON.stringify(crate) });

    expect((await read(CRATE_FILE_NAME)).getEntity('a.jpg').about.map((ref) => ref['@id'])).toEqual([JANE]);
  });

  it('changes nothing on a second run, so it is safe to repeat', async () => {
    currentRoot = await createFixtureTree({ 'ro-crate-metadata.json': oldShapeCrate() });
    const fsAdapter = createNodeFsAdapter(currentRoot);
    await runMigrations({ fsAdapter, only: ['collapse-person-proxies'] });

    const again = await runMigrations({ fsAdapter, only: ['collapse-person-proxies'] });
    expect(again.cratesChanged).toEqual(0);
  });

  it('writes nothing on a dry run, but reports what it would do', async () => {
    const { result, read } = await migrate({ 'ro-crate-metadata.json': oldShapeCrate() }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.cratesChanged).toEqual(1);
    expect((await read(CRATE_FILE_NAME)).getEntity('#person-JaneSmith')).toBeTruthy();
  });
});

describe('remove-root-mentions', () => {
  const only = ['remove-root-mentions'];

  function crateWithMentions() {
    return JSON.stringify({
      '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
        {
          '@id': './', '@type': 'Dataset', name: 'Photo Collection',
          hasPart: [{ '@id': '2005/' }],
          mentions: [{ '@id': JANE }, { '@id': REX }, { '@id': '#relationship-1' }],
        },
        { '@id': '2005/', '@type': 'Dataset', name: '2005' },
        { '@id': JANE, '@type': 'Person', name: 'Jane Smith', description: 'Gran' },
        { '@id': REX, '@type': 'Pet', name: 'Rex' },
        { '@id': '#relationship-1', '@type': 'rico:Relation', 'rico:relationConnects': [{ '@id': JANE }] },
      ],
    });
  }

  it('removes mentions from the root dataset and leaves what it listed in place', async () => {
    const { result, read } = await migrate({ 'ro-crate-metadata.json': crateWithMentions() }, { only });

    expect(result.cratesChanged).toEqual(1);
    expect(result.changes['remove-root-mentions']).toEqual({ mentions: 3 });

    const crate = await read(CRATE_FILE_NAME);
    expect(crate.rootDataset.mentions).toBeUndefined();
    expect(crate.rootDataset.hasPart.map((ref) => ref['@id'])).toEqual(['2005/']);
    expect(crate.getEntity(JANE).description).toEqual(['Gran']);
    expect(crate.getEntity(REX)).toBeTruthy();
    expect(crate.getEntity('#relationship-1')).toBeTruthy();
  });

  it('changes nothing on a second run, or on a crate that never had any', async () => {
    const { fsAdapter } = await migrate({ 'ro-crate-metadata.json': crateWithMentions() }, { only });

    expect((await runMigrations({ fsAdapter, only })).cratesChanged).toEqual(0);
  });

  it('writes nothing on a dry run, but reports what it would do', async () => {
    const { result, read } = await migrate({ 'ro-crate-metadata.json': crateWithMentions() }, { only, dryRun: true });

    expect(result.cratesChanged).toEqual(1);
    expect((await read(CRATE_FILE_NAME)).rootDataset.mentions).toHaveLength(3);
  });
});

describe('refresh-context', () => {
  const only = ['refresh-context'];
  const TERMS = 'https://w3id.org/ldac/rocphotos/terms#';

  // A crate as written before the rocphotos terms were bound: its bare
  // FaceEmbedding falls through @vocab to schema.org.
  function staleCrate() {
    return JSON.stringify({
      '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
        { '@id': './', '@type': 'Dataset', name: 'Face recognition reference data', hasPart: [{ '@id': 'abc' }] },
        { '@id': 'abc', '@type': 'FaceEmbedding', name: 'Jane Smith', sourceImage: '2005/a.jpg' },
      ],
    });
  }

  it('writes the missing term definitions into the file, and leaves the graph alone', async () => {
    const { result, fsAdapter } = await migrate({ 'ro-crate-metadata.json': staleCrate() }, { only });

    expect(result.cratesChanged).toEqual(1);
    expect(result.changes['refresh-context'].crates).toEqual(1);
    expect(result.changes['refresh-context'].terms).toBeGreaterThan(0);

    const onDisk = JSON.parse(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
    const terms = Object.assign({}, ...onDisk['@context'].filter((part) => typeof part === 'object'));
    expect(terms.FaceEmbedding).toEqual(`${TERMS}FaceEmbedding`);
    expect(terms.ImageRegion).toEqual(`${TERMS}ImageRegion`);
    expect(terms.oa).toEqual('http://www.w3.org/ns/oa#');
    expect(onDisk['@graph']).toEqual(JSON.parse(staleCrate())['@graph']);
  });

  it('changes nothing on a second run', async () => {
    const { fsAdapter } = await migrate({ 'ro-crate-metadata.json': staleCrate() }, { only });

    const again = await runMigrations({ fsAdapter, only });
    expect(again.cratesChanged).toEqual(0);
    expect(again.changes['refresh-context']).toEqual({ crates: 0, terms: 0 });
  });

  it('writes nothing on a dry run, but reports what it would do', async () => {
    const { result, fsAdapter } = await migrate({ 'ro-crate-metadata.json': staleCrate() }, { only, dryRun: true });

    expect(result.cratesChanged).toEqual(1);
    expect(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME))).toEqual(staleCrate());
  });

  it('does not make another migration rewrite a stale crate it had nothing to do in', async () => {
    const { result, fsAdapter } = await migrate({ 'ro-crate-metadata.json': staleCrate() }, { only: ['remove-root-mentions'] });

    expect(result.cratesChanged).toEqual(0);
    expect(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME))).toEqual(staleCrate());
  });
});

describe('runMigrations over a collection', () => {
  it('finds every crate by walking the tree, not by reading the index', async () => {
    const { result, read } = await migrate({
      'ro-crate-metadata.json': JSON.stringify({
        '@context': 'https://w3id.org/ro/crate/1.2/context',
        '@graph': [
          { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
          { '@id': './', '@type': 'Dataset', name: 'Root' },
        ],
      }),
      2005: { 'ro-crate-metadata.json': oldShapeCrate() },
      2006: { '03': { 'ro-crate-metadata.json': oldShapeCrate() } },
    });

    expect(result.cratesScanned).toEqual(3); // root, 2005, 2006/03
    expect(result.cratesChanged).toEqual(2);
    expect((await read('2006/03/ro-crate-metadata.json')).getEntity('#person-JaneSmith')).toBeUndefined();
  });

  it('skips a crate it cannot parse and carries on with the rest', async () => {
    const { result, read } = await migrate({
      'ro-crate-metadata.json': oldShapeCrate(),
      broken: { 'ro-crate-metadata.json': '{ not json' },
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toEqual('broken/ro-crate-metadata.json');
    expect(result.cratesChanged).toEqual(1);
    expect((await read(CRATE_FILE_NAME)).getEntity('#person-JaneSmith')).toBeUndefined();
  });

  it('does nothing at all when no migration is selected', async () => {
    currentRoot = await createFixtureTree({ 'ro-crate-metadata.json': oldShapeCrate() });
    const result = await runMigrations({ fsAdapter: createNodeFsAdapter(currentRoot), config: {} });

    expect(result.ran).toEqual([]);
    expect(result.cratesScanned).toEqual(0);
  });

  it('reads the list from the collection\'s own config when not given one', async () => {
    currentRoot = await createFixtureTree({
      'ro-crate-metadata.json': oldShapeCrate(),
      'rocphotos.config.json': JSON.stringify({ migrations: ['collapse-person-proxies'] }),
    });
    const result = await runMigrations({ fsAdapter: createNodeFsAdapter(currentRoot) });

    expect(result.ran).toEqual(['collapse-person-proxies']);
    expect(result.cratesChanged).toEqual(1);
  });
});


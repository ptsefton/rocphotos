import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { createPeopleHandler } from '../src/core/people/handler.js';
import { ensureFacesSchema, addReferenceFace, addDetection, listReferenceFaces, getDetection } from '../src/core/faces/store.js';
import {
  ensureSchema as ensureMainSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  crateEntityId,
  imageEntityId,
  personEntityId,
  getEntityById,
  facetCounts,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, addStandoffFaceRegion, readImageRecord, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;
let mainStore;
let facesStore;
let fsAdapter;
let handleRequest;

const crate2024Id = crateEntityId('2024');
const crate2025Id = crateEntityId('2025');
const aId = imageEntityId('2024', 'a.jpg');
const bId = imageEntityId('2025', 'b.jpg');
const cId = imageEntityId('2025', 'c.jpg');

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

beforeEach(async () => {
  // a.jpg (2024): EXIF-derived region for "jane smith" (the identity being merged away)
  const crate2024 = loadOrCreateCrate(null);
  crate2024.rootDataset.name = '2024';
  addImageEntity(crate2024, {
    path: 'a.jpg',
    exif: { Regions: { RegionList: { Name: 'jane smith', Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } },
    sourceModifiedAt: Date.now(),
  });

  // b.jpg (2025): already depicts the surviving identity "Jane Smith" via a standoff region
  // c.jpg (2025): depicts "jane smith" too, in the same crate as b.jpg
  const crate2025 = loadOrCreateCrate(null);
  crate2025.rootDataset.name = '2025';
  addImageEntity(crate2025, { path: 'b.jpg', exif: {}, sourceModifiedAt: Date.now() });
  addStandoffFaceRegion(crate2025, 'b.jpg', {
    name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
  });
  addImageEntity(crate2025, {
    path: 'c.jpg',
    exif: { Regions: { RegionList: { Name: 'jane smith', Type: 'Face', Area: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } } } },
    sourceModifiedAt: Date.now(),
  });

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(loadOrCreateCrate(null)),
    2024: { 'ro-crate-metadata.json': serializeCrate(crate2024), 'a.jpg': 'fake' },
    2025: { 'ro-crate-metadata.json': serializeCrate(crate2025), 'b.jpg': 'fake', 'c.jpg': 'fake' },
  });

  fsAdapter = createNodeFsAdapter(currentRoot);
  mainStore = openNodeSqlite(':memory:');
  ensureMainSchema(mainStore);
  facesStore = openNodeSqlite(':memory:');
  ensureFacesSchema(facesStore);

  upsertRoCrate(mainStore, { id: crate2024Id, path: '2024', name: '2024' });
  upsertEntity(mainStore, { id: crate2024Id, roCrateId: crate2024Id, entityType: ENTITY_TYPE_COLLECTION, name: '2024' });
  upsertRoCrate(mainStore, { id: crate2025Id, path: '2025', name: '2025' });
  upsertEntity(mainStore, { id: crate2025Id, roCrateId: crate2025Id, entityType: ENTITY_TYPE_COLLECTION, name: '2025' });

  for (const [id, roCrateId, path, record] of [
    [aId, crate2024Id, 'a.jpg', readImageRecord(crate2024, 'a.jpg')],
    [bId, crate2025Id, 'b.jpg', readImageRecord(crate2025, 'b.jpg')],
    [cId, crate2025Id, 'c.jpg', readImageRecord(crate2025, 'c.jpg')],
  ]) {
    upsertEntity(mainStore, { id, roCrateId, entityType: ENTITY_TYPE_IMAGE, name: path, memberOf: roCrateId, title: path });
    upsertFile(mainStore, { id, entityId: id, filename: path, mediaType: 'image/jpeg', size: 4, relativePath: id });
    for (const name of record.people) {
      mainStore.run("INSERT INTO entity_facets (entity_id, facet_name, value) VALUES (?, 'people', ?)", [id, name]);
    }
  }

  addReferenceFace(facesStore, {
    id: 'ref-1', personId: personEntityId('jane smith'), personName: 'jane smith', sourceRegionId: 'a.jpg#region-0',
    sourceImageId: aId, embedding: [1, 2, 3], modelName: 'm', modelVersion: '1',
  });
  addDetection(facesStore, {
    id: 'det-1', imageId: cId, box: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, embedding: [4, 5, 6],
    suggestedPersonId: personEntityId('jane smith'), suggestedPersonName: 'jane smith', status: 'pending', modelName: 'm', modelVersion: '1',
  });

  handleRequest = createPeopleHandler({ mainStore, facesStore, fsAdapter });
});

describe('GET /', () => {
  it('lists every distinct Person with its image count', async () => {
    const res = await handleRequest({ method: 'GET', path: '/' });
    const { people } = JSON.parse(res.body);
    expect(people).toEqual(expect.arrayContaining([
      { name: 'jane smith', imageCount: 2 },
      { name: 'Jane Smith', imageCount: 1 },
    ]));
  });
});

describe('POST /merge', () => {
  it('rejects an empty source list', async () => {
    const res = await handleRequest({ method: 'POST', path: '/merge', body: { sourceNames: [], targetName: 'Jane Smith' } });
    expect(res.status).toEqual(400);
  });

  it('renames one person, a single-source merge, leaving everyone else alone', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith'], targetName: 'Jane Q. Smith' },
    });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).imagesUpdated).toEqual(2); // a.jpg and c.jpg

    expect(facetCounts(mainStore, 'people', {})).toEqual(expect.arrayContaining([
      { value: 'Jane Q. Smith', count: 2 },
      { value: 'Jane Smith', count: 1 }, // b.jpg's own, untouched
    ]));
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Q. Smith'))).toBeTruthy();

    const rewritten2024 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2024/' + CRATE_FILE_NAME)));
    expect(readImageRecord(rewritten2024, 'a.jpg').people).toEqual(['Jane Q. Smith']);
    const [reference] = listReferenceFaces(facesStore, 'm', '1');
    expect(reference.personName).toEqual('Jane Q. Smith');
  });

  it('treats renaming onto a name already in use as a merge into it', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith'], targetName: 'Jane Smith' },
    });
    expect(res.status).toEqual(200);

    expect(facetCounts(mainStore, 'people', {})).toEqual([{ value: 'Jane Smith', count: 3 }]);
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
  });

  it('rejects a missing targetName', async () => {
    const res = await handleRequest({ method: 'POST', path: '/merge', body: { sourceNames: ['jane smith', 'Jane Smith'] } });
    expect(res.status).toEqual(400);
  });

  it('merges across multiple crates into the surviving name, updating crate files, the main index, and the faces index', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith', 'Jane Smith'], targetName: 'Jane Smith' },
    });
    expect(res.status).toEqual(200);
    const result = JSON.parse(res.body);
    expect(result.imagesUpdated).toEqual(2); // a.jpg and c.jpg — b.jpg already was "Jane Smith"

    // Main index: "jane smith" facet is gone, "Jane Smith" now covers all three images.
    const peopleFacets = facetCounts(mainStore, 'people', {});
    expect(peopleFacets).toEqual([{ value: 'Jane Smith', count: 3 }]);
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Smith'))).toBeTruthy();

    // Crate files on disk were rewritten to match.
    const rewritten2024 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2024/' + CRATE_FILE_NAME)));
    expect(readImageRecord(rewritten2024, 'a.jpg').people).toEqual(['Jane Smith']);
    const rewritten2025 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2025/' + CRATE_FILE_NAME)));
    expect(readImageRecord(rewritten2025, 'c.jpg').people).toEqual(['Jane Smith']);
    expect(readImageRecord(rewritten2025, 'b.jpg').people).toEqual(['Jane Smith']);

    // Faces index: the reference and the detection's suggestion both now point at the surviving identity.
    const [reference] = listReferenceFaces(facesStore, 'm', '1');
    expect(reference.personId).toEqual(personEntityId('Jane Smith'));
    expect(reference.personName).toEqual('Jane Smith');
    const detection = getDetection(facesStore, 'det-1');
    expect(detection.suggested_person_id).toEqual(personEntityId('Jane Smith'));

    // The merged-away identity's own Person node must not be left
    // dangling, unreferenced, in either crate that used to hold it.
    expect(rewritten2024.getEntity(personEntityId('jane smith'))).toBeUndefined();
    expect(rewritten2025.getEntity(personEntityId('jane smith'))).toBeUndefined();
  });

  it('carries a merged-away person\'s description over to the one that survives', async () => {
    // The root crate is where a person is described, and the spelling
    // that loses a merge may be the one somebody wrote the description
    // against. Dropping it with the node would lose the only copy.
    const rootPath = CRATE_FILE_NAME;
    const before = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(rootPath)));
    before.addEntity({ '@id': personEntityId('jane smith'), '@type': 'Person', name: 'jane smith', description: 'Gran', birthDate: '1948' });
    before.addValues(before.rootId, 'mentions', { '@id': personEntityId('jane smith') });
    await fsAdapter.writeFile(rootPath, serializeCrate(before));

    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith'], targetName: 'Jane Smith' },
    });
    expect(res.status).toEqual(200);

    const after = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(rootPath)));
    expect(after.getEntity(personEntityId('jane smith'))).toBeUndefined();
    const survivor = after.getEntity(personEntityId('Jane Smith'));
    expect(survivor.description).toEqual(['Gran']);
    expect(survivor.birthDate).toEqual(['1948']);
  });

  it('merges into a brand new name typed by the user, not just one of the source names', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith', 'Jane Smith'], targetName: 'Jane Doe' },
    });
    expect(res.status).toEqual(200);

    const peopleFacets = facetCounts(mainStore, 'people', {});
    expect(peopleFacets).toEqual([{ value: 'Jane Doe', count: 3 }]);
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Doe'))).toBeTruthy();
  });
});

// The profile-driven editor for a person's canonical record (Spec.md's
// "Editing metadata against a MASP profile"). The fields these routes
// serve come from vendor/masp/rocphotos-profile.json by way of
// src/masp/, so what is asserted here is the wiring — that the values
// reach the root crate, and that a rename takes everything else with
// it — not the profile's content, which test/masp-profile-editor.test.js
// covers.
describe('/relationship', () => {
  const PARENT_CHILD = '#ParentChildRelationshipClass';

  async function addPeopleToRoot(...names) {
    const before = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
    for (const name of names) {
      before.addEntity({ '@id': personEntityId(name), '@type': 'Person', name });
      before.addValues(before.rootId, 'mentions', { '@id': personEntityId(name) });
    }
    await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(before));
  }

  async function rootCrateNow() {
    return loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
  }

  it('offers the collection\'s people as candidates, never the person whose page it is', async () => {
    await addPeopleToRoot('jane smith', 'Mum Smith');
    const res = await handleRequest({ method: 'GET', path: '/person', query: { name: 'jane smith' } });
    const parentChild = JSON.parse(res.body).relationshipClasses.find((c) => c.id === PARENT_CHILD);
    const source = parentChild.fields.find((field) => field.name === 'rico:relationHasSource');

    expect(source.widget).toEqual('reference');
    expect(source.options.map((option) => option.name)).toContain('Mum Smith');
  });

  it('links people chosen from the lookup', async () => {
    // The root crate is where identities live, so that is what the
    // picker offers.
    await addPeopleToRoot('jane smith', 'Mum Smith');

    const res = await handleRequest({
      method: 'POST', path: '/relationship',
      body: {
        classRuleId: PARENT_CHILD,
        values: {
          'rico:relationHasSource': personEntityId('Mum Smith'),
          'rico:relationHasTarget': personEntityId('jane smith'),
        },
      },
    });
    expect(res.status).toEqual(200);
    const { id } = JSON.parse(res.body);

    const relationship = (await rootCrateNow()).getEntity(id);
    expect(relationship['rico:relationHasSource'][0]['@id']).toEqual(personEntityId('Mum Smith'));
    expect(relationship['rico:relationHasTarget'][0]['@id']).toEqual(personEntityId('jane smith'));
  });

  it('accepts a person given by name, since a name identifies one here', async () => {
    await addPeopleToRoot('jane smith', 'Mum Smith');

    const res = await handleRequest({
      method: 'POST', path: '/relationship',
      body: {
        classRuleId: PARENT_CHILD,
        values: { 'rico:relationHasSource': 'Mum Smith', 'rico:relationHasTarget': 'jane smith' },
      },
    });
    expect(res.status).toEqual(200);

    const relationship = (await rootCrateNow()).getEntity(JSON.parse(res.body).id);
    expect(relationship['rico:relationHasSource'][0]['@id']).toEqual(personEntityId('Mum Smith'));
  });

  it('refuses somebody who is not in the collection, saying so by name', async () => {
    await addPeopleToRoot('jane smith');

    const res = await handleRequest({
      method: 'POST', path: '/relationship',
      body: {
        classRuleId: PARENT_CHILD,
        values: { 'rico:relationHasSource': 'Someone Not Here', 'rico:relationHasTarget': 'jane smith' },
      },
    });
    expect(res.status).toEqual(422);
    expect(JSON.parse(res.body).problems).toEqual([
      { field: 'rico:relationHasSource', message: expect.stringContaining('nobody called "Someone Not Here"') },
    ]);
  });

  it('rejects a class this profile does not declare', async () => {
    const res = await handleRequest({ method: 'POST', path: '/relationship', body: { classRuleId: '#Nope', values: {} } });
    expect(res.status).toEqual(400);
  });

  it('removes a relationship without touching the people it was about', async () => {
    await addPeopleToRoot('jane smith', 'Mum Smith');
    const created = await handleRequest({
      method: 'POST', path: '/relationship',
      body: {
        classRuleId: PARENT_CHILD,
        values: { 'rico:relationHasSource': 'Mum Smith', 'rico:relationHasTarget': 'jane smith' },
      },
    });
    const { id } = JSON.parse(created.body);

    const res = await handleRequest({ method: 'POST', path: '/relationship/delete', body: { id } });
    expect(JSON.parse(res.body).removed).toBe(true);

    const after = await rootCrateNow();
    expect(after.getEntity(id)).toBeUndefined();
    expect(after.getEntity(personEntityId('Mum Smith'))).toBeTruthy();
  });
});

describe('/person', () => {
  async function rootCrate() {
    return loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
  }

  describe('GET', () => {
    it('describes the fields the profile declares, and what the profile makes of the current values', async () => {
      const res = await handleRequest({ method: 'GET', path: '/person', query: { name: 'jane smith' } });
      expect(res.status).toEqual(200);
      const payload = JSON.parse(res.body);

      expect(payload.id).toEqual(personEntityId('jane smith'));
      expect(payload.fields.map((field) => field.name)).toEqual(['name', 'description', 'birthDate']);
      expect(payload.values).toEqual({ name: ['jane smith'], description: [], birthDate: [] });
      // The profile requires only a name, so a person with nothing else
      // recorded is not incomplete — there is nothing to flag.
      expect(payload.fields.filter((field) => field.required).map((field) => field.name)).toEqual(['name']);
      expect(payload.check.problems).toEqual([]);
    });

    it('rejects a request with no name', async () => {
      expect((await handleRequest({ method: 'GET', path: '/person', query: {} })).status).toEqual(400);
    });
  });

  describe('POST', () => {
    it('writes the values onto the canonical Person in the root crate', async () => {
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'jane smith', description: 'Grandmother', birthDate: '1931-07' } },
      });
      expect(res.status).toEqual(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, renamedFrom: null, imagesUpdated: 0 });

      const person = (await rootCrate()).getEntity(personEntityId('jane smith'));
      expect(person.description).toEqual(['Grandmother']);
      expect(person.birthDate).toEqual(['1931-07']);
    });

    it('saves what is known and leaves out what is not, rather than demanding the rest', async () => {
      // A birth year on its own is a legitimate thing to record, and the
      // profile asks for neither field, so this saves cleanly and the
      // description simply does not appear in the crate.
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'jane smith', description: '', birthDate: '1931' } },
      });
      expect(res.status).toEqual(200);
      expect(JSON.parse(res.body).check.problems).toEqual([]);
      const person = (await rootCrate()).getEntity(personEntityId('jane smith'));
      expect(person.birthDate).toEqual(['1931']);
      expect(person.description).toBeUndefined();
    });


    it('refuses a second value for a property the profile caps at one', async () => {
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'jane smith', description: ['Grandmother', 'Also a cellist'] } },
      });
      expect(res.status).toEqual(422);
      expect(JSON.parse(res.body).problems).toEqual([{ field: 'description', message: expect.stringMatching(/at most 1/) }]);
      expect((await rootCrate()).getEntity(personEntityId('jane smith'))).toBeUndefined();
    });

    it('refuses a value that is filled in but does not match the profile, and writes nothing', async () => {
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'jane smith', description: 'Grandmother', birthDate: 'last Tuesday' } },
      });
      expect(res.status).toEqual(422);
      expect(JSON.parse(res.body).problems).toEqual([{ field: 'birthDate', message: expect.stringMatching(/did not match/) }]);
      expect((await rootCrate()).getEntity(personEntityId('jane smith'))).toBeUndefined();
    });

    it('refuses two names, which would be two people', async () => {
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: ['jane smith', 'Jane Smith'] } },
      });
      expect(res.status).toEqual(400);
    });

    it('skips an image the index lists but its crate no longer holds, rather than failing the whole rename', async () => {
      // A directory deleted outside the app, with no rescan since. One
      // stale row must not stop a rename the rest of the collection can
      // take, and the count reported has to say so.
      await fsAdapter.deleteFile('2024/ro-crate-metadata.json');

      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'Jane Q. Smith', description: 'Grandmother', birthDate: '1931' } },
      });
      expect(res.status).toEqual(200);
      const result = JSON.parse(res.body);
      expect(result.unreadable).toEqual([aId]);
      expect(result.imagesUpdated).toEqual(1); // c.jpg, whose crate is still there
      expect(readImageRecord(loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2025/ro-crate-metadata.json'))), 'c.jpg').people).toEqual(['Jane Q. Smith']);
    });

    async function seedRoot(names, mutate = () => {}) {
      const before = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
      for (const name of names) {
        before.addEntity({ '@id': personEntityId(name), '@type': 'Person', name });
        before.addValues(before.rootId, 'mentions', { '@id': personEntityId(name) });
      }
      mutate(before);
      await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(before));
    }

    it('leaves a parent link alone when the parent is renamed, because the id does not move', async () => {
      await seedRoot(['jane smith', 'Kid Smith'], (crate) => {
        crate.getEntity(personEntityId('Kid Smith')).parent = { '@id': personEntityId('jane smith') };
      });

      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'Jane Q. Smith' } },
      });
      expect(res.status).toEqual(200);
      expect(JSON.parse(res.body)).toMatchObject({ id: personEntityId('jane smith'), name: 'Jane Q. Smith', mergedInto: null });

      const after = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
      // The identity did not move, so the link needed no repointing —
      // which is the point of separating a name from an id.
      expect(after.getEntity(personEntityId('jane smith')).name).toEqual(['Jane Q. Smith']);
      expect(after.getEntity(personEntityId('Jane Q. Smith'))).toBeUndefined();
      expect(unwrapId(after.getEntity(personEntityId('Kid Smith')).parent)).toEqual(personEntityId('jane smith'));
    });

    it('repoints a parent link when two identities really are merged', async () => {
      // Renaming onto a name somebody else already has is still a
      // merge, and that does collapse two ids into one.
      await seedRoot(['jane smith', 'Jane Smith', 'Kid Smith'], (crate) => {
        crate.getEntity(personEntityId('Kid Smith')).parent = { '@id': personEntityId('jane smith') };
      });

      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'Jane Smith' } },
      });
      expect(res.status).toEqual(200);
      expect(JSON.parse(res.body).mergedInto).toEqual(personEntityId('Jane Smith'));

      const after = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(CRATE_FILE_NAME)));
      expect(after.getEntity(personEntityId('jane smith'))).toBeUndefined();
      expect(unwrapId(after.getEntity(personEntityId('Kid Smith')).parent)).toEqual(personEntityId('Jane Smith'));
    });

    it('renames across the whole collection, and keeps the values the rename would otherwise discard', async () => {
      // The ordering this asserts is the whole point: a rename replaces
      // the canonical node outright (syncRootCrateSubjects), so values
      // written before it would be thrown away with the old node.
      const res = await handleRequest({
        method: 'POST', path: '/person',
        body: { name: 'jane smith', values: { name: 'Jane Q. Smith', description: 'Grandmother', birthDate: '1931' } },
      });
      expect(res.status).toEqual(200);
      expect(JSON.parse(res.body)).toMatchObject({ renamedFrom: 'jane smith', imagesUpdated: 2 });

      // The id is the one she was minted under and does not move; only
      // the label does.
      expect(JSON.parse(res.body).id).toEqual(personEntityId('jane smith'));
      const person = (await rootCrate()).getEntity(personEntityId('jane smith'));
      expect(person.name).toEqual(['Jane Q. Smith']);
      expect(person.description).toEqual(['Grandmother']);
      expect(person.birthDate).toEqual(['1931']);

      // And everything a merge would have updated is updated: the index
      // facets, the sub-collection crates, and the faces index.
      expect(facetCounts(mainStore, 'people', {})).toEqual(expect.arrayContaining([{ value: 'Jane Q. Smith', count: 2 }]));
      expect(getEntityById(mainStore, personEntityId('jane smith')).name).toEqual('Jane Q. Smith');
      const rewritten2024 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2024/ro-crate-metadata.json')));
      expect(readImageRecord(rewritten2024, 'a.jpg').people).toEqual(['Jane Q. Smith']);
      expect(listReferenceFaces(facesStore, 'm', '1')[0].personName).toEqual('Jane Q. Smith');
    });
  });
});

// A reference read back under { array: true } arrives as a one-element
// array; several assertions above need to look inside one.
function unwrapId(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' ? first['@id'] : undefined;
}

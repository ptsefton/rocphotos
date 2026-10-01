import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import {
  COLLECTION_PROFILE_PATH,
  collectionProfileEditor,
  describeActiveProfile,
  installCollectionProfile,
  removeCollectionProfile,
  availableRelationshipClasses,
  profileProblems,
} from '../src/core/masp/collectionProfile.js';
import { MAIN_PERSON_CLASS } from '../src/masp/rocphotosProfile.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

const builtIn = () => fs.readFileSync('vendor/masp/rocphotos-profile.json', 'utf8');

async function collection() {
  currentRoot = await createFixtureTree({ 'ro-crate-metadata.json': '{}' });
  return createNodeFsAdapter(currentRoot);
}

// A profile that declares a person and nothing else — the shape of a
// real tweak, where somebody has cut things out to see what happens.
function minimalProfile() {
  return {
    '@context': 'https://w3id.org/ro/crate/1.2/context',
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
      { '@id': './', '@type': ['Dataset', 'Profile'], name: 'A trimmed-down profile', hasResource: [{ '@id': '#schema' }] },
      {
        '@id': '#schema',
        '@type': 'ResourceDescriptor',
        hasRole: { '@id': 'http://www.w3.org/ns/dx/prof/role/schema' },
        hasPart: [{ '@id': MAIN_PERSON_CLASS }, { '@id': '#prop_person_name' }],
      },
      {
        '@id': MAIN_PERSON_CLASS, '@type': 'rdfs:Class', name: 'Someone',
        'prov:specializationOf': { '@id': 'http://schema.org/Person' },
      },
      {
        '@id': '#prop_person_name', '@type': 'rdf:Property', name: 'name', 'rdfs:label': 'name',
        'rdfs:comment': 'What to call them', domainIncludes: { '@id': MAIN_PERSON_CLASS },
        rangeIncludes: { '@id': 'http://schema.org/Text' }, 'sh:minCount': '1',
      },
    ],
  };
}

describe('which profile a collection is edited through', () => {
  it('uses the one built into the app until the collection carries its own', async () => {
    const fsAdapter = await collection();
    const active = await describeActiveProfile(fsAdapter);

    expect(active.source).toEqual('built-in');
    expect(active.path).toEqual('vendor/masp/rocphotos-profile.json');
    expect(active.relationshipClasses.map((c) => c.name)).toEqual(['Married', 'Parent and child']);
  });

  it('uses the collection\'s own once one is installed, and says so', async () => {
    const fsAdapter = await collection();
    expect(await installCollectionProfile(fsAdapter, JSON.stringify(minimalProfile()))).toEqual({ installed: true, problems: [] });

    const active = await describeActiveProfile(fsAdapter);
    expect(active.source).toEqual('collection');
    expect(active.path).toEqual(COLLECTION_PROFILE_PATH);
    expect(active.person.name).toEqual('Someone');
    expect((await collectionProfileEditor(fsAdapter)).fields(MAIN_PERSON_CLASS).map((f) => f.name)).toEqual(['name']);
  });

  it('offers only the relationship kinds the installed profile declares', async () => {
    // The point of letting somebody try a change is that the result may
    // be a smaller profile than the one shipped.
    const fsAdapter = await collection();
    await installCollectionProfile(fsAdapter, JSON.stringify(minimalProfile()));

    expect(availableRelationshipClasses(await collectionProfileEditor(fsAdapter))).toEqual([]);
    expect((await describeActiveProfile(fsAdapter)).relationshipClasses).toEqual([]);
  });

  it('goes back to the built-in one', async () => {
    const fsAdapter = await collection();
    await installCollectionProfile(fsAdapter, JSON.stringify(minimalProfile()));

    expect(await removeCollectionProfile(fsAdapter)).toBe(true);
    expect((await describeActiveProfile(fsAdapter)).source).toEqual('built-in');
    expect(await removeCollectionProfile(fsAdapter)).toBe(false);
  });

  it('installs the app\'s own profile without complaint, which is the floor', async () => {
    const fsAdapter = await collection();
    expect((await installCollectionProfile(fsAdapter, builtIn())).installed).toBe(true);
    expect((await describeActiveProfile(fsAdapter)).relationshipClasses.map((c) => c.name))
      .toEqual(['Married', 'Parent and child']);
  });
});

describe('refusing a profile this app cannot edit through', () => {
  it('says so when the file is not JSON', async () => {
    const fsAdapter = await collection();
    const { installed, problems } = await installCollectionProfile(fsAdapter, 'not json at all');

    expect(installed).toBe(false);
    expect(problems[0]).toMatch(/not JSON/);
    expect((await describeActiveProfile(fsAdapter)).source).toEqual('built-in');
  });

  it('says so when it declares no person class', async () => {
    // Only what the app genuinely cannot work without is required.
    const profile = minimalProfile();
    profile['@graph'] = profile['@graph'].filter((e) => e['@id'] !== MAIN_PERSON_CLASS);

    expect(profileProblems(profile)[0]).toMatch(/declares no #MainPersonClass/);
  });

  it('says so when a person has no name, which identity here depends on', async () => {
    const profile = minimalProfile();
    profile['@graph'] = profile['@graph'].filter((e) => e['@id'] !== '#prop_person_name');

    expect(profileProblems(profile)[0]).toMatch(/declares no "name" property/);
  });

  it('writes nothing when it refuses', async () => {
    const fsAdapter = await collection();
    const profile = minimalProfile();
    profile['@graph'] = profile['@graph'].filter((e) => e['@id'] !== MAIN_PERSON_CLASS);

    await installCollectionProfile(fsAdapter, JSON.stringify(profile));
    expect(await fsAdapter.exists(COLLECTION_PROFILE_PATH)).toBe(false);
  });

  it('falls back rather than breaking when the installed file is later mangled by hand', async () => {
    // It was checked when it went in, so reaching this means somebody
    // edited the file — and they need a working editor to fix it from.
    const fsAdapter = await collection();
    await installCollectionProfile(fsAdapter, JSON.stringify(minimalProfile()));
    await fsAdapter.writeFile(COLLECTION_PROFILE_PATH, '{ broken');

    const editor = await collectionProfileEditor(fsAdapter);
    expect(editor.fields(MAIN_PERSON_CLASS).map((f) => f.name)).toEqual(['name', 'description', 'birthDate']);
  });
});

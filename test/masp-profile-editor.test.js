import { describe, it, expect } from 'vitest';
import { loadOrCreateCrate } from '../src/core/crateBuilder.js';
import { createProfileEditor } from '../src/masp/profileEditor.js';
import { rocphotosProfileEditor, MAIN_PERSON_CLASS, PARENT_CHILD_RELATIONSHIP_CLASS } from '../src/masp/rocphotosProfile.js';
import { personEntityId } from '../src/core/db/store.js';

const JANE = personEntityId('Jane Doe');

// Built the way the application builds one, so the crate carries the
// prefix bindings a real crate has — without `rico` bound, a
// relationship's own `@type` would not resolve to the RiC class its
// rule names.
function crateWith(entity) {
  const crate = loadOrCreateCrate(null);
  crate.rootDataset.name = 'A collection';
  crate.addEntity(entity);
  crate.addValues(crate.rootId, 'mentions', { '@id': entity['@id'] });
  return crate;
}

// A profile with one class and one required property, for the cases
// where what is being shown is the component's own behaviour rather
// than anything about this collection's profile.
function tinyProfile() {
  return {
    '@context': 'https://w3id.org/ro/crate/1.2/context',
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
      { '@id': './', '@type': ['Dataset', 'Profile'], name: 'Tiny profile', hasResource: [{ '@id': '#schema' }] },
      {
        // MASP finds a profile's rules through the schema-role
        // descriptor, never by scanning the graph.
        '@id': '#schema',
        '@type': 'ResourceDescriptor',
        hasRole: { '@id': 'http://www.w3.org/ns/dx/prof/role/schema' },
        hasPart: [{ '@id': '#WidgetClass' }, { '@id': '#prop_widget_sku' }],
      },
      {
        '@id': '#WidgetClass',
        '@type': 'rdfs:Class',
        name: 'Widget',
        'prov:specializationOf': { '@id': 'http://schema.org/Product' },
      },
      {
        '@id': '#prop_widget_sku',
        '@type': 'rdf:Property',
        name: 'sku',
        'rdfs:label': 'sku',
        'rdfs:comment': 'The stock number',
        domainIncludes: { '@id': '#WidgetClass' },
        rangeIncludes: { '@id': 'http://schema.org/Text' },
        'sh:minCount': '1',
      },
    ],
  };
}

describe('createProfileEditor', () => {
  it('derives its fields from the profile rather than from anything hardcoded', () => {
    const fields = rocphotosProfileEditor().fields(MAIN_PERSON_CLASS);
    expect(fields.map((field) => field.name)).toEqual(['name', 'description', 'birthDate']);
    // Help text is the profile's own rdfs:comment, not prose written here.
    expect(fields.find((field) => field.name === 'birthDate').help).toMatch(/maximum available precision/);
  });

  it('asks for a text input for a date, so a year on its own stays expressible', () => {
    const birthDate = rocphotosProfileEditor().fields(MAIN_PERSON_CLASS).find((field) => field.name === 'birthDate');
    // MASP accepts YYYY, YYYY-MM and YYYY-MM-DD alike; <input type="date">
    // would accept only the last of the three.
    expect(birthDate.widget).toEqual('date');
    expect(birthDate.types).toEqual(['Date']);
  });

  it('names a class by its rule id, not by its type', () => {
    const editor = rocphotosProfileEditor();
    // Two rules in this profile specialise schema:Person — the
    // collection-wide identity and the per-crate instance — so a type
    // name would not say which was meant.
    expect(editor.classInfo(MAIN_PERSON_CLASS).name).toEqual('Person');
    expect(editor.classInfo('#InstancePersonClass').name).toEqual('Person in this crate');
    expect(() => editor.classInfo('#NoSuchClass')).toThrow(/No class rule/);
  });

  it('accepts a person described by name alone, since the profile asks for nothing else', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });

    const check = await editor.check(crate, JANE, MAIN_PERSON_CLASS);
    expect(check.valid).toEqual(true);
    expect(check.problems).toEqual([]);
  });

  it('reports a missing required property against the field it belongs to', async () => {
    // Nothing a Person needs is optional any more, so the mechanism is
    // shown against a profile that does require something — it is the
    // component being tested here, not this collection's profile.
    const editor = createProfileEditor({ profile: tinyProfile() });
    const crate = crateWith({ '@id': '#w1', '@type': 'Product' });

    const check = await editor.check(crate, '#w1', '#WidgetClass');
    expect(check.valid).toEqual(false);
    expect(check.problems).toEqual([{ field: 'sku', message: 'missing required property sku' }]);
  });

  it('refuses a second value for a property the profile caps at one', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });

    editor.write(crate, JANE, { description: ['Grandmother', 'Also a cellist'] });
    const check = await editor.check(crate, JANE, MAIN_PERSON_CLASS);
    expect(check.valid).toEqual(false);
    expect(check.fields.description.message).toMatch(/at most 1/);
  });

  it('accepts a birth date given only to the year, and rejects one that is not a date', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe', description: 'Grandmother' });

    editor.write(crate, JANE, { birthDate: '1931' });
    expect((await editor.check(crate, JANE, MAIN_PERSON_CLASS)).valid).toEqual(true);

    editor.write(crate, JANE, { birthDate: '1931-07' });
    expect((await editor.check(crate, JANE, MAIN_PERSON_CLASS)).valid).toEqual(true);

    editor.write(crate, JANE, { birthDate: 'last Tuesday' });
    const check = await editor.check(crate, JANE, MAIN_PERSON_CLASS);
    expect(check.valid).toEqual(false);
    expect(check.fields.birthDate.message).toMatch(/did not match/);
  });

  it('removes a property cleared in the form rather than storing an empty string', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe', description: 'Grandmother', birthDate: '1931' });

    editor.write(crate, JANE, { description: '   ' });
    // An empty string would read as a description that says nothing, and
    // against a profile that required one it would satisfy the minCount
    // while doing so.
    expect(editor.read(crate, JANE, MAIN_PERSON_CLASS).description).toEqual([]);
    expect(JSON.stringify(crate)).not.toMatch(/"description"/);
  });

  it('trims what it stores and leaves properties the caller did not mention alone', () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe', birthDate: '1931' });

    editor.write(crate, JANE, { description: '  Grandmother  ' });
    const values = editor.read(crate, JANE, MAIN_PERSON_CLASS);
    expect(values.description).toEqual(['Grandmother']);
    expect(values.birthDate).toEqual(['1931']);
  });

  it('says which class a reference field points at, by rule id', () => {
    const source = rocphotosProfileEditor()
      .fields(PARENT_CHILD_RELATIONSHIP_CLASS)
      .find((field) => field.name === 'rico:relationHasSource');

    expect(source.widget).toEqual('reference');
    // The rule id, not the type label: a host needs it to ask
    // candidates() who qualifies, and two rules here share schema:Person.
    expect(source.referenceClasses).toEqual([MAIN_PERSON_CLASS]);
  });

  it('offers every entity satisfying the referenced class as a candidate, in name order', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });
    crate.addEntity({ '@id': personEntityId('Mum Doe'), '@type': 'Person', name: 'Mum Doe' });
    crate.addEntity({ '@id': personEntityId('Dad Doe'), '@type': 'Person', name: 'Dad Doe' });
    // Not a Person at all, so never a candidate for a Person reference.
    crate.addEntity({ '@id': '#album1', '@type': 'ImageGallery', name: 'Aardvark album' });

    expect(await editor.candidates(crate, MAIN_PERSON_CLASS)).toEqual([
      { id: personEntityId('Dad Doe'), name: 'Dad Doe' },
      { id: JANE, name: 'Jane Doe' },
      { id: personEntityId('Mum Doe'), name: 'Mum Doe' },
    ]);
  });

  it('stores a reference as a link, turning a bare id into one', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });
    crate.addEntity({ '@id': personEntityId('Mum Doe'), '@type': 'Person', name: 'Mum Doe' });
    crate.addEntity({ '@id': '#rel-1', '@type': 'rico:ChildRelation' });

    // A form submits strings; which of them are references is something
    // only the profile knows, so the class is passed in and the
    // coercion happens here rather than in every caller.
    editor.write(crate, '#rel-1', {
      'rico:relationHasSource': personEntityId('Mum Doe'),
      'rico:relationHasTarget': JANE,
    }, PARENT_CHILD_RELATIONSHIP_CLASS);

    expect(editor.read(crate, '#rel-1', PARENT_CHILD_RELATIONSHIP_CLASS)['rico:relationHasSource'])
      .toEqual([{ '@id': personEntityId('Mum Doe') }]);
    expect((await editor.check(crate, '#rel-1', PARENT_CHILD_RELATIONSHIP_CLASS)).valid).toBe(true);
  });

  it('takes as many values as the profile allows on a repeatable reference', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });
    crate.addEntity({ '@id': personEntityId('Spouse Doe'), '@type': 'Person', name: 'Spouse Doe' });
    crate.addEntity({ '@id': '#rel-1', '@type': 'rico:SpouseRelation' });

    editor.write(crate, '#rel-1', {
      'rico:relationConnects': [JANE, personEntityId('Spouse Doe')],
    }, '#SpouseRelationshipClass');

    expect(editor.read(crate, '#rel-1', '#SpouseRelationshipClass')['rico:relationConnects']).toHaveLength(2);
    expect((await editor.check(crate, '#rel-1', '#SpouseRelationshipClass')).valid).toBe(true);
  });

  it('rejects a reference the crate does not contain', async () => {
    const editor = rocphotosProfileEditor();
    const crate = crateWith({ '@id': JANE, '@type': 'Person', name: 'Jane Doe' });
    crate.addEntity({ '@id': '#rel-1', '@type': 'rico:ChildRelation' });

    editor.write(crate, '#rel-1', {
      'rico:relationHasSource': personEntityId('Nobody At All'),
      'rico:relationHasTarget': JANE,
    }, PARENT_CHILD_RELATIONSHIP_CLASS);

    const check = await editor.check(crate, '#rel-1', PARENT_CHILD_RELATIONSHIP_CLASS);
    expect(check.valid).toBe(false);
    expect(check.fields['rico:relationHasSource'].message).toMatch(/does not exist in the crate/);
  });

  it('builds from any profile, not only this application\'s', async () => {
    // The point of the component: a different profile produces different
    // fields with no change here.
    const editor = createProfileEditor({ profile: tinyProfile() });

    expect(editor.fields('#WidgetClass')).toEqual([
      { id: '#prop_widget_sku', name: 'sku', label: null, help: 'The stock number', required: true, multiple: true, types: ['Text'], values: [], referenceClasses: [], widget: 'text' },
    ]);
  });
});

import { ROCrate } from 'ro-crate';
import { MaspValidator } from './validator.js';

/**
 * A profile-driven editing environment for RO-Crate entities.
 *
 * Nothing in this module knows about photographs, people, or rocphotos.
 * It takes a MASP profile crate and an RO-Crate to edit, and it answers
 * three questions about any class the profile describes: what fields
 * does an entity of this class have, what are this entity's current
 * values, and what does the profile say is wrong with them. The profile
 * is the only source for all three — nothing is hardcoded here — so a
 * property added to a profile becomes a field without a line changing
 * in this file or in the form that renders it.
 *
 * That is also why the form itself lives in webview/masp/entityForm.js
 * and not here: this half needs `ro-crate` and the validator, that half
 * needs a document, and neither needs the other's dependency. The two
 * together are the editing environment, and the pair is what would move
 * into a library once a second application wants it.
 *
 * ## Addressing a class
 *
 * Classes are addressed by the `@id` of their rule in the profile crate
 * (`#MainPersonClass`), never by type name. Two rules in one profile
 * routinely specialise the same type — the rocphotos profile has two for
 * `schema:Person`, the collection-wide identity and the per-crate
 * instance, told apart only by which properties they require — so a type
 * name does not identify a class rule, and the validator's own
 * getClassRuleForType('Person') returns whichever of the two the profile
 * happens to list first.
 *
 * ## Values are always arrays
 *
 * `read()` returns every property as an array, however many values it
 * holds, because `multiple` is a profile decision that can change, and a
 * caller that special-cased the single-value shape would then quietly
 * read the wrong thing. `write()` accepts a bare value or an array.
 */

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The plain value behind whatever ro-crate hands back for a property: a
 * linked entity becomes `{'@id': …}`, a literal stays itself. Kept
 * JSON-serialisable because these values travel over the API to a form
 * running in a page that has no crate of its own.
 */
function plainValue(value) {
  if (value && typeof value === 'object') {
    return value['@id'] !== undefined ? { '@id': value['@id'] } : JSON.parse(JSON.stringify(value));
  }
  return value;
}

/**
 * One element of an enumerated range, as a form can use it.
 *
 * A MASP ItemList enumerates IRIs, and where the profile also defines
 * the term those resolve to the whole `DefinedTerm`. A picker needs
 * both halves: the id to store and the name to show. Falls back to the
 * id as its own label for a list that only names IRIs, which is what
 * an ItemList pointing at a vocabulary defined elsewhere looks like.
 */
function enumeratedValue(value) {
  if (value && typeof value === 'object' && value['@id'] !== undefined) {
    const name = asArray(value.name).find((item) => typeof item === 'string');
    return { id: value['@id'], name: name ?? value['@id'] };
  }
  return { id: value, name: String(value) };
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

/**
 * Chooses the input a field wants from what the profile says its range
 * is. Deliberately coarse: it distinguishes only what changes the
 * markup, and `overrides` covers the rest.
 *
 * `date` is a text input rather than `<input type="date">` on purpose:
 * MASP accepts `YYYY`, `YYYY-MM` and `YYYY-MM-DD` alike (see the
 * validator's isValidDate), and a native date picker would make the two
 * shorter forms unreachable for exactly the cases — a birth year nobody
 * recorded the day of — that they exist to cover.
 */
function widgetFor(types, values) {
  if (values.length > 0) return 'select';
  if (types.includes('Date') || types.includes('DateTime')) return 'date';
  if (types.length === 0 || types.includes('Text')) return 'text';
  return 'reference';
}

/**
 * ## Overrides
 *
 * `overrides` patches the field descriptors a profile produces, keyed by
 * property rule `@id`. It exists for the two kinds of thing a MASP
 * profile cannot say: that a text property is a paragraph rather than a
 * line, and that the application storing the crate has a limit of its
 * own the profile has no reason to carry.
 *
 * It changes only what `fields()` reports, never what `check()` decides.
 * Validation stays the profile's answer alone — an application that
 * accepts less than the profile does has to enforce that itself, where
 * it can say why.
 *
 * @param {object} options
 * @param {object|import('ro-crate').ROCrate} options.profile - the profile crate, as parsed JSON-LD or an already-built ROCrate
 * @param {Record<string, object>} [options.overrides] - per-field patches keyed by property rule `@id`, e.g. `{'#prop_person_description': {widget: 'textarea'}}`
 */
export function createProfileEditor({ profile, overrides = {} }) {
  const profileCrate = typeof profile?.getEntity === 'function'
    ? profile
    : new ROCrate(profile, { array: true, link: true });
  const validator = new MaspValidator(profileCrate);

  function classRuleFor(classRuleId) {
    validator.ensureParsed();
    const rule = validator.rules.classes[classRuleId];
    if (!rule) {
      throw new Error(`No class rule ${classRuleId} in this profile. It has: ${Object.keys(validator.rules.classes).join(', ')}`);
    }
    return rule;
  }

  /**
   * Every property rule that applies to a class, its own and the ones it
   * inherits — the same PropertyRule objects the validator itself runs,
   * taken from it rather than re-derived, so a form can never offer a
   * field validation does not know about, or miss one it does.
   */
  function propertyRulesFor(classRuleId) {
    const { own, inherited } = validator.inheritedPropertyRules(classRuleId);
    const seen = new Set();
    const rules = [];
    // A class's own rules first, then what it inherits. The specific
    // comes before the general: a parent-child relationship is about a
    // parent and a child, and the dates it shares with every other
    // kind of relationship belong after them, not above them.
    for (const rule of [...own, ...Object.values(inherited).flat()]) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      rules.push(rule);
    }
    return rules;
  }

  function entityOrThrow(crate, entityId) {
    const entity = crate.getEntity(entityId);
    if (!entity) throw new Error(`No entity ${entityId} in this crate`);
    return entity;
  }

  /**
   * A plain copy of an entity the profile defines, references flattened
   * back to `{'@id': …}`, or null if the profile does not define it.
   *
   * Used to carry a chosen term's definition into the crate that uses
   * it — see write(). The profile crate is linked, so reading an
   * entity off it gives resolved neighbours; this unpicks that back
   * into something addEntity will take.
   */
  function profileEntity(id) {
    const entity = profileCrate.getEntity(id);
    if (!entity) return null;
    const plain = {};
    for (const [property, value] of Object.entries(entity)) {
      if (property === '@reverse') continue;
      const values = asArray(value).map((item) => (
        item && typeof item === 'object' && item['@id'] !== undefined ? { '@id': item['@id'] } : item
      ));
      plain[property] = values.length === 1 && !Array.isArray(value) ? values[0] : values;
    }
    return plain;
  }

  /** The profile's own label and prose for a class, for a form's heading. */
  function classInfo(classRuleId) {
    const rule = classRuleFor(classRuleId);
    // `types` is what an entity of this class must carry as its
    // `@type` — the profile's own answer, so a caller creating one
    // need not know which vocabulary the class came from.
    return { id: rule.id, name: rule.name, description: rule.description || '', types: [...rule.resolvedTypes] };
  }

  /** JSON-serialisable field descriptors, in the profile's own order. */
  function fields(classRuleId) {
    return propertyRulesFor(classRuleFor(classRuleId).id).map((rule) => {
      const definition = validator.toEditorDefinition(rule);
      const types = asArray(definition.type);
      const values = asArray(definition.values).map(enumeratedValue);
      return {
        id: definition.id,
        name: definition.name,
        // What to put beside the box, where the profile says. A MASP
        // property rule's `rdfs:label` is the property as written into
        // the crate, prefix and all, because that is what the validator
        // looks up on an entity — which makes it exactly the wrong
        // string to read off a screen. Its `name` is the readable one,
        // and a rule declared per class can use it to say what that
        // property means in that class ("Parent", not "Relation has
        // source"). A profile that only repeats the term there has
        // said nothing, and the form makes its own label.
        label: asArray(rule.entity.name).find((value) => typeof value === 'string' && value !== definition.name) ?? null,
        help: definition.help || '',
        required: definition.required === true,
        multiple: definition.multiple === true,
        types,
        values,
        // The class rules this field's value must satisfy, where its
        // range names one — what turns "this points at something" into
        // "this points at one of these", since the host can then ask
        // candidates() for them. Empty for a literal field.
        referenceClasses: referenceClassesFor(rule),
        widget: widgetFor(types, values),
        ...overrides[definition.id],
      };
    });
  }

  function referenceClassesFor(rule) {
    return asArray(rule.rangeIncludes)
      .map((range) => (typeof range === 'object' && range !== null ? range['@id'] : range))
      .filter((rangeId) => rangeId && validator.rules.classes[rangeId]);
  }

  /**
   * Every entity in a crate that satisfies a class rule — what a field
   * referencing that class can be pointed at.
   *
   * Decided by running the rule, not by matching `@type`: a profile
   * routinely declares several classes over one type (this one has two
   * for `schema:Person`) and tells them apart by what they must carry,
   * so a type test would offer the wrong set. The caller filters
   * further — excluding the entity being edited, say, which is its
   * business and not the profile's.
   *
   * @returns {Promise<Array<{id: string, name: string}>>} in name order
   */
  async function candidates(crate, classRuleId) {
    const found = [];
    for (const id of await instancesOf(crate, classRuleId)) {
      const entity = crate.getEntity(id);
      found.push({ id, name: asArray(entity.name).map(plainValue).find((value) => typeof value === 'string') ?? id });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The ids of every entity in a crate that satisfies a class rule.
   *
   * Decided by running the rule, which is the only way that works
   * here: a profile routinely declares several classes over one type
   * — this one has two for `schema:Person` and two for `rico:Relation`
   * — and tells them apart by what each must carry, so matching on
   * `@type` would return both members of every such pair.
   *
   * @returns {Promise<string[]>}
   */
  async function instancesOf(crate, classRuleId) {
    const found = [];
    for (const entity of crate.entities()) {
      if ((await check(crate, entity['@id'], classRuleId)).valid) found.push(entity['@id']);
    }
    return found;
  }

  /** This entity's current value for each of the class's fields. */
  function read(crate, entityId, classRuleId) {
    const entity = entityOrThrow(crate, entityId);
    const values = {};
    for (const field of fields(classRuleId)) {
      values[field.name] = asArray(entity[field.name]).map(plainValue);
    }
    return values;
  }

  /**
   * Sets the given properties on an entity, trimming strings and
   * removing a property whose value is now blank.
   *
   * Removing matters: a field cleared in a form arrives as `''`, and
   * storing that would leave an entity that satisfies a `minCount` the
   * profile meant to enforce while a reader finds it has no name at all.
   * Properties the caller did not mention are left alone, so a form
   * covering three of an entity's fields cannot drop the rest.
   *
   * Given a `classRuleId`, a plain string arriving for a field whose
   * range is a class becomes `{'@id': …}`. A form submits strings for
   * every field; which of them are references is something only the
   * profile knows, so this is where it is applied rather than asking
   * every caller to work it out.
   */
  function write(crate, entityId, values, classRuleId = null) {
    const entity = entityOrThrow(crate, entityId);
    // Both kinds of field whose value is an IRI rather than a literal:
    // one pointing at another entity, and one picking from an
    // enumerated list of terms. A form submits a string for each, and
    // which of them need wrapping as `{'@id': …}` is something only the
    // profile knows.
    const references = new Set(
      classRuleId
        ? fields(classRuleId)
          .filter((field) => field.referenceClasses.length > 0 || field.values.some((option) => typeof option.id === 'string' && /^\w+:/.test(option.id)))
          .map((field) => field.name)
        : [],
    );
    for (const [name, raw] of Object.entries(values)) {
      const kept = asArray(raw)
        .filter((value) => !isBlank(value))
        .map((value) => (references.has(name) && typeof value === 'string' ? { '@id': value } : value));
      // The crate's own deleteProperty, not `delete entity[name]`: an
      // entity is a Proxy whose delete trap refuses a property that is
      // not there, and clearing a field that was already empty is the
      // ordinary case on a first save.
      if (kept.length === 0) {
        crate.deleteProperty(entityId, name);
        continue;
      }
      entity[name] = kept.map((value) => (typeof value === 'string' ? value.trim() : value));

      // A chosen term's definition is copied in alongside the choice.
      // MASP resolves an enumerated value inside the crate being
      // validated, so a crate naming a term it does not contain fails
      // — and a crate that carries the definition reads on its own,
      // which is the point of RO-Crate. Rewritten on every save, so a
      // term whose definition changes upstream is brought into line
      // the next time anything touches the entity.
      for (const value of kept) {
        const termId = value && typeof value === 'object' ? value['@id'] : null;
        const definition = termId ? profileEntity(termId) : null;
        if (definition) crate.addEntity(definition, { replace: true });
      }
    }
  }

  /**
   * What the profile says about one entity, field by field.
   *
   * Reports per field rather than as a list of sentences because that is
   * what a form needs: a message beside the input it is about. A
   * whole-crate run produces prose naming the entity and the property,
   * which would have to be parsed back apart to get here; running each
   * PropertyRule directly gives the same verdict already separated, from
   * the same rule objects a full validation uses.
   */
  async function check(crate, entityId, classRuleId) {
    const classRule = classRuleFor(classRuleId);
    const entity = entityOrThrow(crate, entityId);

    // The validator resolves ranges and terms against whichever crate it
    // was last pointed at, so it is pointed at this one before any rule
    // runs, and its memo of already-validated entities is dropped: this
    // entity has just been edited, and a verdict cached from before the
    // edit is exactly the wrong answer.
    await crate.resolveContext();
    validator.targetCrate = crate;
    validator.validatedEntities = {};
    validator.rulesDone.clear();
    validator.clearResults();

    const typed = classRule.validateEntityTypes(entity);
    const byField = {};
    let valid = typed;
    for (const rule of propertyRulesFor(classRule.id)) {
      const ok = rule.validate(entity);
      if (!ok) valid = false;
      byField[rule.propertyName] = { valid: ok, message: ok ? null : rule.lastFailureReason };
    }

    return {
      valid,
      typed,
      expectedTypes: classRule.resolvedTypes,
      fields: byField,
      problems: Object.entries(byField)
        .filter(([, result]) => !result.valid)
        .map(([field, result]) => ({ field, message: result.message })),
    };
  }

  /** The validator's own whole-crate run, for a caller that wants it. */
  function validateCrate(crate) {
    return validator.validateCrate(crate);
  }

  return { classInfo, fields, read, write, check, candidates, instancesOf, profileEntity, validateCrate };
}

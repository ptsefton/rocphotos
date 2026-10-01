/**
 * A form built from MASP field descriptors, in plain DOM.
 *
 * The other half of the editing environment in src/masp/: that half
 * reads a profile and validates a crate against it, this half turns the
 * field descriptors it produces into inputs and reads them back. Neither
 * knows about photographs or people, and neither imports the other —
 * this file imports nothing at all, because the web view is served
 * straight off disk by `rocphotos serve` with no bundler in the way, so
 * anything here has to be what a browser can load on its own.
 *
 * It renders whatever it is given. Adding a property to the MASP profile
 * adds a field here with no change to this file: the descriptor carries
 * the label, the help text, whether the field is required, whether it
 * repeats, and which input it wants.
 *
 * Validation is not done here. A profile's rules resolve references
 * against the crate being edited, which this form does not have, so the
 * server decides and the result arrives through setProblems().
 */

/**
 * "birthDate" -> "Birth date", "rico:relationHasSource" -> "Relation
 * has source".
 *
 * A MASP property rule is named for the property as it is written into
 * the crate, prefix and all, because that is what the validator looks
 * up on an entity. That makes it exactly the wrong string to put on a
 * screen, so the prefix goes and the camel case is broken apart.
 */
function labelFor(name) {
  const local = String(name).replace(/^[A-Za-z][\w-]*:/, '');
  const spaced = local.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What to call a field: the profile's own words for it in this class
 * where it gives any, and the property name tidied up otherwise.
 *
 * The profile's words win because only the profile knows what a
 * property means in a particular class — "Parent" and "Child" for the
 * two ends of a parent-child relationship, where the property names
 * are the same `relationHasSource`/`relationHasTarget` pair every
 * directed relationship uses.
 */
function fieldLabel(field) {
  return field.label || labelFor(field.name);
}

function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== null && value !== undefined && value !== false) node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** The text in an input, for a value that may be a literal or a reference. */
function asText(value) {
  if (value && typeof value === 'object') return value['@id'] ?? '';
  return value === null || value === undefined ? '' : String(value);
}

/**
 * A lookup over entities already in the crate, for a field whose value
 * is a reference to one of them.
 *
 * An input with a datalist rather than a `<select>`: the list is every
 * person in the collection, which is hundreds, and typing a few letters
 * to narrow it is the only way that is usable. It also leaves the
 * typed text visible, so a name that matches nothing can be shown back
 * with the problem beside it instead of silently resetting.
 *
 * What is displayed is the entity's name and what is submitted is its
 * id; `getValues` maps back through the same list. A name that is not
 * in it passes through as typed, and the server says who it could not
 * find — a better message than anything this side could produce, since
 * it is the side that knows what the collection holds.
 */
function referenceInput(field, value, listId) {
  const options = field.options ?? [];
  const current = asText(value);
  const input = element('input', {
    type: 'text',
    className: 'masp-input',
    autocomplete: 'off',
    placeholder: options.length > 0 ? 'Start typing a name…' : 'Nobody else is recorded in this collection yet',
    value: options.find((option) => option.id === current)?.name ?? current,
  });
  input.setAttribute('list', listId);
  input.dataset.reference = 'true';
  return input;
}

function inputFor(field, value, listId) {
  if (field.widget === 'reference') return referenceInput(field, value, listId);
  if (field.widget === 'textarea') {
    return element('textarea', { value: asText(value), rows: 4, className: 'masp-input' });
  }
  // An enumerated range: each option carries the id to store and the
  // name to show, so the dropdown reads as words rather than IRIs.
  if (field.widget === 'select' && field.values.length > 0) {
    const select = element('select', { className: 'masp-input' }, [
      element('option', { value: '', textContent: field.required ? 'Choose…' : '(none)' }),
      ...field.values.map((option) => element('option', { value: option.id, textContent: option.name })),
    ]);
    select.value = asText(value);
    return select;
  }
  // A date is a text input on purpose: MASP accepts a bare year and a
  // year-month as well as a full date, and a native date picker would
  // make the first two unreachable.
  if (field.widget === 'date') {
    return element('input', {
      type: 'text', value: asText(value), className: 'masp-input',
      placeholder: 'YYYY, YYYY-MM or YYYY-MM-DD', inputMode: 'numeric', autocomplete: 'off',
    });
  }
  return element('input', { type: 'text', value: asText(value), className: 'masp-input', autocomplete: 'off' });
}

/**
 * @param {object} options
 * @param {Array<object>} options.fields - field descriptors, as src/masp/profileEditor.js's fields() produces them
 * @param {Record<string, Array<any>>} [options.values] - current values, keyed by property name
 * @param {string} [options.submitLabel]
 * @param {(values: Record<string, Array<string>>) => void} [options.onSubmit]
 * @param {() => void} [options.onCancel]
 * @param {(fieldName: string, id: string) => void} [options.onOpenReference] - called when somebody asks to open the entity a reference field points at; without it, no such button is offered
 * @param {[string, string]|null} [options.swap] - two single-valued fields holding the same kind of thing, which a button then lets somebody exchange
 * @param {string} [options.referenceIcon] - what to show on the button that opens a referenced entity
 * @returns {{element: HTMLElement, getValues: () => Record<string, Array<string>>, setValues: (values: object) => void, setProblems: (problems: Array<{field: string, message: string}>) => void, setStatus: (text: string, kind?: string) => void, setBusy: (busy: boolean) => void, focusFirst: () => void, isDirty: () => boolean, markSaved: () => void}}
 */
export function createEntityForm({ fields, values = {}, submitLabel = 'Save', onSubmit = null, onCancel = null, onOpenReference = null, swap = null, referenceIcon = '\u2192' }) {
  const rows = new Map();
  // One datalist per reference field, shared by all of its rows: the
  // options are the same for each, and a list per row would put
  // hundreds of duplicate <option> elements in the document for a
  // person with several parents.
  const listIdFor = (field) => `masp-options-${field.name}`;

  let initialValues = values;

  const optionIdFor = (field, text) => (field.options ?? []).find((option) => option.name === text || option.id === text)?.id;

  function addValueRow(field, container, value) {
    const input = inputFor(field, value, listIdFor(field));
    const row = element('div', { class: 'masp-value' }, [input]);

    // A reference is a thing in its own right, so a form showing one
    // should let you go and look at it — and, this being the same
    // editor, edit it. The host decides what opening means; without a
    // handler there is nowhere to go and no button is offered.
    if (field.widget === 'reference' && onOpenReference) {
      const open = element('button', {
        // The icon says what kind of thing is on the other end, which
        // the host supplies: a reference reads as the thing it names,
        // and an arrow is reserved for the shape of a relationship.
        type: 'button', class: 'masp-open', textContent: referenceIcon,
        title: `Open this ${fieldLabel(field).toLowerCase()}`,
        onclick: () => {
          const id = optionIdFor(field, input.value.trim());
          if (id) onOpenReference(field.name, id);
        },
      });
      // Enabled only once the text names something real: there is
      // nothing to open while somebody is still half-way through
      // typing, and a button that does nothing when pressed is worse
      // than one that is visibly not ready.
      const sync = () => { open.disabled = !optionIdFor(field, input.value.trim()); };
      sync();
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      row.append(open);
    }

    if (field.multiple) {
      row.append(element('button', {
        type: 'button', class: 'masp-remove', textContent: '×',
        title: `Remove this ${fieldLabel(field).toLowerCase()}`,
        onclick: () => {
          row.remove();
          // Never leave a repeating field with no input at all: there
          // would then be nothing to type into, and no way back.
          if (container.children.length === 0) addValueRow(field, container, '');
        },
      }));
    }
    container.append(row);
    return input;
  }

  function fieldBlock(field) {
    const container = element('div', { class: 'masp-values' });
    const current = asArray(values[field.name]);
    for (const value of current.length > 0 ? current : ['']) addValueRow(field, container, value);

    const problem = element('p', { class: 'masp-problem', hidden: true });
    const children = [
      element('label', { class: 'masp-label', title: field.name }, [
        document.createTextNode(fieldLabel(field)),
        ...(field.required ? [element('span', { class: 'masp-required', textContent: 'required' })] : []),
      ]),
    ];
    if (field.help) children.push(element('p', { class: 'masp-help', textContent: field.help }));
    children.push(container);
    if (field.multiple) {
      children.push(element('button', {
        // Not "+ Add another spouses": a profile's label for a
        // repeating field may already be plural, and nothing here can
        // tell. The button sits under the field it belongs to, so the
        // field name belongs in the tooltip rather than the sentence.
        type: 'button', class: 'masp-add', textContent: '+ Add another',
        title: `Add another value for ${fieldLabel(field)}`,
        onclick: () => addValueRow(field, container, '').focus(),
      }));
    }
    children.push(problem);

    if (field.widget === 'reference') {
      children.push(element(
        'datalist',
        { id: listIdFor(field) },
        (field.options ?? []).map((option) => element('option', { value: option.name })),
      ));
    }

    const block = element('div', { class: 'masp-field', dataset: { field: field.name } }, children);
    rows.set(field.name, { field, container, problem });
    return block;
  }

  // Built before anything that reads `rows`, which fieldBlock fills.
  const blocksByName = new Map(fields.map((field) => [field.name, fieldBlock(field)]));

  const status = element('p', { class: 'masp-status', hidden: true });
  const submit = element('button', { type: 'submit', class: 'masp-submit', textContent: submitLabel });

  // Two slots that hold the same kind of thing can be filled the wrong
  // way round, and nothing but the person typing knows which way is
  // right — a profile can say that both ends of a parent-child
  // relationship take a Person, not which of two people is the parent.
  // So the form offers the exchange rather than making somebody retype
  // both.
  //
  // The control sits beside the pair it acts on rather than down among
  // Save and Cancel, because what it does is local to those two boxes
  // and nothing about a button at the foot of a form would say so. The
  // icon is two arrows passing; the words go in the title, named from
  // the fields themselves, so it reads "Swap parent and child" without
  // this file knowing what either is.
  const swappable = swap && swap.every((name) => blocksByName.has(name));
  const swapButton = swappable
    ? element('button', {
      type: 'button',
      class: 'masp-swap',
      textContent: '\u21c5',
      title: `Swap ${swap.map((name) => fieldLabel(rows.get(name).field).toLowerCase()).join(' and ')}`,
      ariaLabel: `Swap ${swap.map((name) => fieldLabel(rows.get(name).field).toLowerCase()).join(' and ')}`,
      onclick: () => {
        const [first, second] = swap.map((name) => rows.get(name).container.querySelector('.masp-input'));
        if (!first || !second) return;
        [first.value, second.value] = [second.value, first.value];
        for (const input of [first, second]) input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    })
    : null;
  const cancel = element('button', { type: 'button', class: 'masp-cancel', textContent: 'Cancel', onclick: () => onCancel?.() });

  // The two swappable fields are shown as one group with the button
  // alongside; everything else keeps its own place and its own order.
  const laidOut = [];
  for (const field of fields) {
    if (swappable && field.name === swap[1]) continue;
    if (swappable && field.name === swap[0]) {
      laidOut.push(element('div', { class: 'masp-swap-pair' }, [
        element('div', { class: 'masp-swap-fields' }, swap.map((name) => blocksByName.get(name))),
        swapButton,
      ]));
      continue;
    }
    laidOut.push(blocksByName.get(field.name));
  }

  const form = element('form', { class: 'masp-form', novalidate: true }, [
    ...laidOut,
    status,
    element('div', { class: 'masp-actions' }, onCancel ? [submit, cancel] : [submit]),
  ]);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit?.(getValues());
  });

  function getValues() {
    const result = {};
    for (const [name, { field, container }] of rows) {
      // A reference shows a name and submits an id. Text that matches
      // no option is submitted as typed, so the server can say who it
      // could not find rather than the form quietly dropping it.
      const byName = new Map((field.options ?? []).map((option) => [option.name, option.id]));
      result[name] = [...container.querySelectorAll('.masp-input')]
        .map((input) => input.value.trim())
        .filter((value) => value !== '')
        .map((value) => byName.get(value) ?? value);
    }
    return result;
  }

  function setValues(next) {
    initialValues = next;
    for (const [name, { field, container }] of rows) {
      container.replaceChildren();
      const current = asArray(next[name]);
      for (const value of current.length > 0 ? current : ['']) addValueRow(field, container, value);
    }
  }

  /**
   * Shows each message beside the field it is about. Everything is
   * cleared first, so a problem fixed since the last save stops being
   * shown rather than lingering next to a field that is now fine.
   */
  function setProblems(problems) {
    for (const { problem } of rows.values()) {
      problem.textContent = '';
      problem.hidden = true;
    }
    for (const { field, message } of asArray(problems)) {
      const row = rows.get(field);
      if (!row) continue;
      row.problem.textContent = message || 'This value does not match the profile.';
      row.problem.hidden = false;
    }
  }

  function setStatus(text, kind = '') {
    status.textContent = text || '';
    status.className = `masp-status${kind ? ` masp-status-${kind}` : ''}`;
    status.hidden = !text;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    cancel.disabled = busy;
    if (swapButton) swapButton.disabled = busy;
  }

  function focusFirst() {
    form.querySelector('.masp-input')?.focus();
  }

  /**
   * Takes what is on screen as the new baseline, without re-rendering.
   * A host calls this once a save has gone through: the form is then
   * showing exactly what was stored, so it is no longer dirty, and a
   * guard that still thought it was would refuse to let anybody leave.
   */
  function markSaved() {
    initialValues = getValues();
  }

  /**
   * Whether anything has been typed since the form was built, last
   * given new values, or last saved. A host navigating away needs to
   * know, so that following a reference cannot quietly discard an edit
   * nobody saved.
   */
  function isDirty() {
    const current = getValues();
    return Object.keys(current).some((name) => {
      const before = asArray(initialValues[name]).map(asText).filter((text) => text !== '');
      return JSON.stringify(before) !== JSON.stringify(current[name]);
    });
  }

  return { element: form, getValues, setValues, setProblems, setStatus, setBusy, focusFirst, isDirty, markSaved };
}

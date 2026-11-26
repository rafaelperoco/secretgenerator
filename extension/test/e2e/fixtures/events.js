// Loaded by the fixture pages. Records, at the document, the events a fill
// dispatches, the way a framework that delegates its listeners sees them:
// only an event that bubbles arrives here, and from inside a shadow tree
// only one that is composed.
//
// Events of the browser itself are left out: the tests move the window
// focus around, and every move comes with a focus event of its own. What a
// script dispatches is never trusted, so that tells the two apart.
window.fixtureEvents = [];
for (const type of ["keydown", "input", "change", "keyup", "focusin", "focusout"]) {
  document.addEventListener(type, (event) => {
    if (event.isTrusted) return;
    const field = event.composedPath()[0];
    window.fixtureEvents.push({
      type,
      field: field.id,
      bubbles: event.bubbles,
      composed: event.composed,
      inputType: event.inputType ?? null,
      // What a listener reads from the field at this moment.
      value: field.value ?? null,
    });
  });
}

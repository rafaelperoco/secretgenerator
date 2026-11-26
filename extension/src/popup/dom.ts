// Typed lookup for the popup's static markup.

/** The element with this id. A missing id is a markup bug, so it throws. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup.html has no #${id}`);
  return el as T;
}

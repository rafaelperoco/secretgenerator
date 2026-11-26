// The tab strip, following the WAI-ARIA tabs pattern with automatic
// activation: arrow keys move focus and select in one step, and only the
// selected tab is in the Tab order (roving tabindex).
import { TABS, type Tab } from "../lib/settings.js";
import { byId } from "./dom.js";

const tabButton = (tab: Tab): HTMLElement => byId(`tab-${tab}`);

/** Marks one tab as selected and shows its panel. Does not move focus. */
export function showTab(active: Tab): void {
  for (const tab of TABS) {
    const selected = tab === active;
    const button = tabButton(tab);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(`panel-${tab}`).hidden = !selected;
  }
}

/** Moves keyboard focus to a tab's button. */
export function focusTab(tab: Tab): void {
  tabButton(tab).focus({ preventScroll: true });
}

/** Calls onSelect when the user picks a tab with the pointer or the keyboard. */
export function initTabs(onSelect: (tab: Tab) => void): void {
  TABS.forEach((tab, index) => {
    const button = tabButton(tab);
    button.addEventListener("click", () => onSelect(tab));
    button.addEventListener("keydown", (event) => {
      const last = TABS.length - 1;
      let target: number;
      switch (event.key) {
        case "ArrowRight":
          target = index === last ? 0 : index + 1;
          break;
        case "ArrowLeft":
          target = index === 0 ? last : index - 1;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      const next = TABS[target];
      onSelect(next);
      focusTab(next);
    });
  });
}

// @ts-check

/**
 * Match the initial server filter using the movement kinds the page already drew. The filter
 * is view state on the same item, not a page in the Back history.
 * @param {MouseEvent} event
 * @param {HTMLAnchorElement} link
 * @param {Map<HTMLAnchorElement, string>} filters
 * @param {Map<HTMLLIElement, string>} movements
 * @param {HTMLOListElement} timeline
 * @param {HTMLParagraphElement} empty
 * @param {boolean} local
 */
export function filter(event, link, filters, movements, timeline, empty, local) {
  if (
    !local ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const kind = filters.get(link);
  if (kind === undefined) return;

  // As with Corten ChoiceGroup, a refresh and a shared link use the address of the choice.
  if (link.href !== location.href) history.replaceState(history.state, "", link.href);
  event.preventDefault();
  for (const option of filters.keys()) {
    if (option === link) option.setAttribute("aria-current", "page");
    else option.removeAttribute("aria-current");
  }
  let any = false;
  for (const [movement, movementKind] of movements) {
    const visible = kind === "" || kind === movementKind;
    movement.hidden = !visible;
    any ||= visible;
  }
  timeline.hidden = !any;
  empty.hidden = any;
}

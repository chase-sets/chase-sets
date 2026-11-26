// @ts-check
// SectionNav (admin_nav.rs): a client navigation patches the section's pages in place, so the
// Sections sheet and the phone bar's More list would stay open over the next page. Following one
// of their links closes it first; Corten's link handling still makes the navigation.

/** Whether the click was on a link. @param {Event} event */
function onLink(event) {
  return event.target instanceof Element && event.target.closest("a[href]") !== null;
}

/**
 * Closes the Sections sheet when one of its links is followed.
 * @param {PointerEvent} event
 * @param {HTMLDialogElement} target The sheet.
 */
export function followed(event, target) {
  if (onLink(event) && target.open) target.close();
}

/**
 * Hides the phone bar's More list when one of its links is followed.
 * @param {PointerEvent} event
 * @param {HTMLUListElement} target The More list.
 */
export function picked(event, target) {
  if (onLink(event) && target.matches(":popover-open")) target.hidePopover();
}

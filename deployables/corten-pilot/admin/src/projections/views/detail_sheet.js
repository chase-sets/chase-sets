// @ts-check

/**
 * The sheet arrives open and non-modal, which works without this script. Reopen it as a modal,
 * so focus stays inside and the console behind it is inert, and let Escape follow the close link,
 * so the address and the history stay what the link would make them. The same as the postage
 * policy sheet's: corten-ui's `dialog::modal` closes the dialog on Escape but leaves the address
 * naming it (todd-skelton/corten, filed with this port).
 *
 * @param {HTMLDialogElement} sheet
 * @param {HTMLAnchorElement} back
 * @param {AbortSignal} signal
 */
export function open(sheet, back, signal) {
  // Before the first paint (no frame shows the sheet non-modal first): `showModal` lays out
  // the page, which the first paint needs anyway.
  if (sheet.open && !sheet.matches(":modal")) {
    sheet.close();
    sheet.showModal();
  }
  sheet.addEventListener(
    "cancel",
    (event) => {
      if (event.target !== sheet) return;
      event.preventDefault();
      back.click();
    },
    { signal },
  );
}

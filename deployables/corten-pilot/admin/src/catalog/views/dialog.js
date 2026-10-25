// @ts-check

/**
 * A dialog that arrives open (a form that came back without JavaScript, a preview patched in, a
 * page that answers with one) is open but not modal, which works without this script. Reopen it
 * as a modal, so focus moves into it and the page behind is inert, as one its button opened is.
 * A dialog that arrives closed is left alone.
 * @param {HTMLDialogElement} dialog
 */
export function modal(dialog) {
  if (dialog.open && !dialog.matches(":modal")) {
    dialog.close();
    dialog.showModal();
  }
}

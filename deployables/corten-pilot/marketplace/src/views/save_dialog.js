// @ts-check

/**
 * Add to List's dialog arrives open when its form came back refused (without JavaScript, the
 * page the post answers with). Open is not modal: reopen it as a modal, so focus moves into it
 * and the page behind is inert, as when its button opens it. A dialog that arrives closed is
 * left alone. admin's catalog dialogs (admin/src/catalog/views/dialog.js) do the same. Goes when
 * Corten opens a server-drawn dialog as a modal itself (todd-skelton/corten#86).
 * @param {HTMLDialogElement} dialog
 */
export function modal(dialog) {
  if (dialog.open && !dialog.matches(":modal")) {
    dialog.close();
    dialog.showModal();
  }
}

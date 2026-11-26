// @ts-check
// JobStatusFilter (job_status_filter.rs): the stylesheet narrows the rows to the chosen status and
// the form's Apply keeps it in the address without this. With it, Apply is hidden, and the address
// and the filter's `data-catalog-import-job-status-filter` follow the choice, as admin-web's does,
// when the page is drawn (a choice the browser restored included) and on each change.

/** @param {HTMLFormElement} filter @param {HTMLButtonElement} apply */
export function connect(filter, apply) {
  apply.hidden = true;
  chosen(filter);
}

/** @param {HTMLFormElement} filter */
export function chosen(filter) {
  const select = filter.querySelector("select");
  if (!select) return;
  filter.dataset.catalogImportJobStatusFilter = select.value;
  const to = new URL(location.href);
  if (select.value === "all") to.searchParams.delete(select.name);
  else to.searchParams.set(select.name, select.value);
  if (to.href !== location.href) history.replaceState(history.state, "", to);
}

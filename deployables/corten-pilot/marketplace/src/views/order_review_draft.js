// @ts-check
// The review form's draft and its resolution analytics, after marketplace's `ReviewSubmissionPage`
// and `trackReviewResolutionEvent`: a buyer who leaves to open an order issue keeps what they
// wrote in this tab's session storage, and the form takes it back the next time it opens. Each
// event goes to window listeners and dataLayer with category labels, booleans and counts only,
// never the review's words; nothing goes to the server. Without the script nothing is kept or
// counted, and the page works the same.

/** Marketplace's window event for the funnel (`REVIEW_RESOLUTION_ANALYTICS_EVENT`). */
const EVENT = "chase-sets:review-resolution-analytics";
/** A rating at or under this asks a buyer to resolve first (`LOW_RATING_RESOLUTION_THRESHOLD`). */
const LOW_RATING = 2;

/** @param {string} order */
const key = (order) => `chase-sets:review-draft:${order}`;

/**
 * @param {string} name
 * @param {Record<string, string | boolean>} [properties]
 */
function track(name, properties = {}) {
  const detail = { event: name, ...properties };
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
  /** @type {any} */ (window).dataLayer?.push(detail);
}

/**
 * What the form holds now.
 * @param {HTMLFormElement} form
 */
function draft(form) {
  const data = new FormData(form);
  return {
    rating: Number(data.get("rating") ?? 0),
    feedback: String(data.get("feedback") ?? ""),
    problemCategories: data.getAll("problemCategories").map(String),
  };
}

/**
 * Why the form asks to resolve first (`resolutionTriggerReason`).
 * @param {{ rating: number, problemCategories: string[] }} draft
 */
function trigger({ rating, problemCategories }) {
  const low = rating <= LOW_RATING;
  const problem = problemCategories.length > 0;
  if (low && problem) return "low-rating-and-problem-indicator";
  if (low) return "low-rating";
  return problem ? "problem-indicator" : "none";
}

/**
 * The form joined the page: a draft kept for this order fills it, once. A draft that cannot be
 * read is left as it is, and the form keeps what the server drew.
 * @param {HTMLFormElement} form
 * @param {string} order
 */
export function resume(form, order) {
  let stored = null;
  try {
    stored = sessionStorage.getItem(key(order));
  } catch {
    return;
  }
  if (!stored) return;
  try {
    const kept = JSON.parse(stored);
    if (typeof kept.rating === "number") {
      for (const star of form.querySelectorAll('input[name="rating"]')) {
        if (star instanceof HTMLInputElement) star.checked = star.value === String(kept.rating);
      }
    }
    const words = form.elements.namedItem("feedback");
    if (typeof kept.feedback === "string" && words instanceof HTMLTextAreaElement) words.value = kept.feedback;
    if (Array.isArray(kept.problemCategories)) {
      for (const box of form.querySelectorAll('input[name="problemCategories"]')) {
        if (box instanceof HTMLInputElement) box.checked = kept.problemCategories.includes(box.value);
      }
    }
    sessionStorage.removeItem(key(order));
    track("review_resolution_draft_resumed");
  } catch {
    // A malformed draft is left alone; the form keeps what the server drew.
  }
}

/**
 * Resolve this order first? joined the page.
 * @param {HTMLElement} group
 * @param {boolean} buyer
 * @param {boolean} intake whether an order issue can be opened
 */
export function shown(group, buyer, intake) {
  const form = group.closest("form");
  if (!form) return;
  const reason = trigger(draft(form));
  track("review_resolution_interstitial_shown", {
    triggerCategory: reason,
    paymentProtection: buyer,
    intakeAvailable: intake,
  });
  if (!intake) track("review_resolution_intake_unavailable", { triggerCategory: reason });
}

/**
 * Open an order issue followed: the form is kept for this order, then counted.
 * @param {HTMLAnchorElement} link
 * @param {string} order
 */
export function resolveFirst(link, order) {
  const form = link.closest("form");
  if (!form) return;
  const kept = draft(form);
  try {
    sessionStorage.setItem(key(order), JSON.stringify(kept));
  } catch {
    // Without storage the buyer still goes to resolve; the draft is not kept.
  }
  track("review_resolution_resolve_first_selected", { triggerCategory: trigger(kept) });
  const first = kept.problemCategories[0];
  track("review_resolution_case_routed", first ? { triggerCategory: first } : {});
}

/**
 * Track order issue followed while the review is held.
 * @param {boolean} buyer
 */
export function existingCase(buyer) {
  track("review_resolution_existing_case_routed", { paymentProtection: buyer });
}

/**
 * The form sent: Continue with feedback only and Go back are counted. One a handler stopped, or
 * the browser held back, is not.
 * @param {SubmitEvent} event
 */
export function submitted(event) {
  if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
  const button = event.submitter;
  const intent = button instanceof HTMLButtonElement && button.name === "intent" ? button.value : "";
  if (intent !== "feedback-only" && intent !== "edit") return;
  const reason = trigger(draft(event.target));
  track(intent === "edit" ? "review_resolution_abandoned" : "review_resolution_feedback_only_selected", {
    triggerCategory: reason,
  });
}

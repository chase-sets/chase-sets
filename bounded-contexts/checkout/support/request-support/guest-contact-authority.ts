/**
 * A guest's contact as Auth reports it. Only Auth's answer makes it `bound`; `unbound` means Auth
 * answered and nothing is bound; `indeterminate` means Auth did not answer, or answered in a shape
 * Checkout cannot read, which is neither.
 */
export type GuestContactAuthority =
  | Readonly<{ state: "bound"; contactEmail: string; contactName: string }>
  | Readonly<{ state: "unbound" }>
  | Readonly<{ state: "indeterminate"; reason: "rate-limited" | "unreadable" }>;

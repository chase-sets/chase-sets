/**
 * Public server surface for the Customer Feedback context.
 *
 * This is the versioned CSAT contract that the sibling leaves (–)
 * consume: survey identity, the workflow/outcome allow-list, the source-context
 * outcome-fact schema, sampling metadata, the invitation shape and versioned
 * lifecycle event contracts, the CSAT/response-rate calculation, the legacy
 * classification decision, and the replay-compatibility base.
 *
 * It is intentionally React-free (structure rule R44): this surface is for
 * request/SSR and cross-context contract composition only.
 */
export * from "./features/csat/domain";

import { loadSourceObservationEvidence } from "../../support/route-support/admin-integrations/observation-evidence-loader";

// Resource route for the Source Observation review evidence SideSheet.
// Thin composition root: the loader composes a single Source Observation's deep
// evidence detail. The review module's evidence sheet fetches this route (via
// useFetcher, keyed by observationId) only when the sheet opens, so the review
// list does not ship deep evidence for every row. It renders no component — it
// is a data-only endpoint.
export const loader = loadSourceObservationEvidence;

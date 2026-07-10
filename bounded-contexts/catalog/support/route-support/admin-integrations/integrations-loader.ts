import type { LoaderFunctionArgs } from "react-router";
import { loadDailySurface } from "./integrations-loader-support";

// Daily import-to-promotion surface route loader (/admin/integrations). Loads and
// computes only the daily import-to-promotion slice: provider/readiness baseline,
// durable jobs, the Source Observation review wave, and the promotion preview. It
// does not fetch the selected authoring model or lifecycle impacts, and the
// read model does not compute the governance, lifecycle, release, or audit
// sub-models — those belong to the other surfaces.
export async function loader(args: LoaderFunctionArgs) {
  return loadDailySurface(args);
}

export { commandFeedbackFromUrl } from "./integrations-command-feedback";

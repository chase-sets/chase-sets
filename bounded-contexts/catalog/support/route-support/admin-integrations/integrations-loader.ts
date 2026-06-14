import type { LoaderFunctionArgs } from "react-router";
import { loadDailySurface } from "./integrations-loader-support";

// Daily import-to-promotion surface route loader (/admin/integrations). Loads and
// computes only the daily import-to-promotion slice: provider/readiness baseline,
// durable jobs, the Source Observation review wave, and the promotion preview. It
// no longer fetches the selected authoring model or lifecycle impacts, and the
// read model no longer computes the governance, lifecycle, release, or audit
// sub-models (#1744).
export async function loader(args: LoaderFunctionArgs) {
  return loadDailySurface(args);
}

export { commandFeedbackFromUrl } from "./integrations-command-feedback";

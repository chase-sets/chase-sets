import type { LoaderFunctionArgs } from "react-router";
import { loadHealthSurface } from "./integrations-loader-support";

// Integration health surface route loader (/admin/integrations/health). Loads
// only the shared baseline (the health triage and audit timeline slices derive
// from the control plane overview) and computes only those slices its surface
// renders.
export async function loader(args: LoaderFunctionArgs) {
  return loadHealthSurface(args);
}

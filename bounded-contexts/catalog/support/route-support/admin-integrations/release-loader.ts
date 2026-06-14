import type { LoaderFunctionArgs } from "react-router";
import { loadReleaseSurface } from "./integrations-loader-support";

// Release evidence and health surface route loader
// (/admin/integrations/release). Loads only the shared baseline (the clean reset
// release, audit evidence, and health triage slices derive from the control plane
// overview) and computes only those slices its surface renders (#1744).
export async function loader(args: LoaderFunctionArgs) {
  return loadReleaseSurface(args);
}

import type { LoaderFunctionArgs } from "react-router";
import { loadGovernanceSurface } from "./integrations-loader-support";

// Govern and recover surface route loader (/admin/integrations/governance). Loads
// the shared baseline plus the selected profile lifecycle impacts and computes
// only the conflict-resolution, lifecycle-recovery, and governance-controls
// slices its surface renders.
export async function loader(args: LoaderFunctionArgs) {
  return loadGovernanceSurface(args);
}

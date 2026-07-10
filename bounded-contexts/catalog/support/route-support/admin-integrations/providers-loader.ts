import type { LoaderFunctionArgs } from "react-router";
import { loadProvidersSurface } from "./integrations-loader-support";

// Provider profiles and readiness surface route loader
// (/admin/integrations/providers). Loads the shared baseline plus the selected
// provider profile authoring model and computes only the profile-authoring and
// validation-readiness slices its surface renders.
export async function loader(args: LoaderFunctionArgs) {
  return loadProvidersSurface(args);
}

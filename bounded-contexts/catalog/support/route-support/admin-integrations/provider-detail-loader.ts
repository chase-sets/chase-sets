import type { LoaderFunctionArgs } from "react-router";
import { loadHealthSurface } from "./integrations-loader-support";

// Catalog health owns provider path, schedule and Operator answers.
export async function loadProviderDetail(args: LoaderFunctionArgs) {
  return loadHealthSurface(args);
}

import type { LoaderFunctionArgs } from "react-router";
import { loader as integrationsLoader } from "./integrations-loader";

// Loader entry point for the /admin/integrations/release surface route. For
// #1739 it reuses the shared integrations read-model composition; per-route
// read-model slicing is the separate concern of #1744.
export async function loader(args: LoaderFunctionArgs) {
  return integrationsLoader(args);
}

// Prepare the Inventory reader before the first pending-setup navigation without failing the route if it is unavailable.
export const readSetupLocations =
  (await import("./setup-locations").catch(() => null))?.readConnectionSetupLocations ?? null;

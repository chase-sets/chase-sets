export type InventoryCaller = { path: string; line: number; family: string; symbol: string };
export type InventoryCallerDiscovery = {
  callers: InventoryCaller[];
  scanned: number;
  total: number;
  ignored: string[];
};
export function trackedInventorySources(repositoryRoot?: string): { path: string; source: string }[];
export function discoverInventoryCallers(sources: { path: string; source: string }[]): InventoryCallerDiscovery;
export function partitionInventoryCallers(
  discovery: InventoryCallerDiscovery,
  registry: Record<
    string,
    { families: string[]; authority: string; attempt: string; read: string; consumer: string; status: string }
  >,
): Omit<InventoryCallerDiscovery, "callers"> & { callers: (InventoryCaller & { status: string })[] };

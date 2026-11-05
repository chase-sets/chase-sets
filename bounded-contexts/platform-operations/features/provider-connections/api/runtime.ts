import type {
  ProviderConnectionsCrossContextPort,
  ProviderConnectionsReadSource,
  ProviderConnectionRow,
  ProviderConnectionsResponseRow,
} from "./contracts";
import { providerConnectionFreshness } from "./freshness";

async function readSection(source: ProviderConnectionsReadSource | undefined): Promise<{
  state: "available" | "partial" | "unavailable";
  rows: readonly ProviderConnectionRow[];
}> {
  if (!source) return { state: "unavailable", rows: [] };
  try {
    const result = await source();
    return { state: result.complete ? "available" : "partial", rows: result.rows };
  } catch {
    return { state: "unavailable", rows: [] };
  }
}

export function createProviderConnectionsRuntime(port: ProviderConnectionsCrossContextPort = {}) {
  return {
    async read() {
      const [catalog, channels] = await Promise.all([readSection(port.catalog), readSection(port.channels)]);
      const evaluatedAt = new Date().toISOString();
      const classify = (row: ProviderConnectionRow): ProviderConnectionsResponseRow => ({
        ...row,
        ...providerConnectionFreshness(row, evaluatedAt),
      });
      return {
        evaluatedAt,
        catalog: { ...catalog, rows: catalog.rows.map(classify) },
        channels: { ...channels, rows: channels.rows.map(classify) },
      };
    },
  };
}

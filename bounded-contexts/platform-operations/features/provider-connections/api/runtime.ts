import type {
  ProviderConnectionsCrossContextPort,
  ProviderConnectionsReadSource,
  ProviderConnectionsSection,
} from "./contracts";

async function readSection(source: ProviderConnectionsReadSource | undefined): Promise<ProviderConnectionsSection> {
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
      return { evaluatedAt: new Date().toISOString(), catalog, channels };
    },
  };
}

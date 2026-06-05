import type { ProviderAdapter } from "./provider-adapter";

export class ProviderAdapterRegistry {
  readonly #adaptersByProviderKey: ReadonlyMap<string, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[]) {
    const next = new Map<string, ProviderAdapter>();

    for (const adapter of adapters) {
      const providerKey = normalizeProviderKey(adapter.providerKey);

      if (next.has(providerKey)) {
        throw new Error(`Duplicate provider adapter registered for '${providerKey}'.`);
      }

      next.set(providerKey, adapter);
    }

    this.#adaptersByProviderKey = next;
  }

  get(providerKey: string): ProviderAdapter | undefined {
    return this.#adaptersByProviderKey.get(normalizeProviderKey(providerKey));
  }

  require(providerKey: string): ProviderAdapter {
    const adapter = this.get(providerKey);

    if (!adapter) {
      throw new Error(`Provider adapter '${normalizeProviderKey(providerKey)}' is not registered.`);
    }

    return adapter;
  }

  listProviderKeys(): readonly string[] {
    return [...this.#adaptersByProviderKey.keys()];
  }
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}

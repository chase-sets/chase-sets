import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import { normalizeLorcanaImageAsset } from "../seeding/product-asset-normalization";
import {
  createProviderSendAdmission,
  providerSendPolicy,
  ProviderSendStoppedError,
  runCatalogProviderWork,
  type ProviderSendRefusal,
} from "./provider-send-admission";
import { createPostgresProviderSendLedger, providerSendInstalledQuotas } from "./provider-send-ledger";
import { createScrydexOnePieceProviderAdapter } from "./scrydex/adapter";

// Synthetic SQL protocol double exercises the real classifier, not DB concurrency.
function installedLedger(pass = 0, nonScrydexUsed = 0) {
  const units = {
    1: "scrydex:lorcana:single-card:source-observation-import",
    2: "scrydex:lorcana:set:reference-data",
    9: "scrydex:lorcana:single-card:source-observation-import",
    10: "scrydex:lorcana:set:reference-data",
    17: "scrydex:one-piece:single-card:source-observation-import",
    18: "scrydex:one-piece:sealed-product:source-observation-import",
  };
  const row = {
    window_id: "synthetic-destination-window",
    phase: pass === 0 ? "preflight" : "pass",
    pass,
    state: "armed",
    used: nonScrydexUsed,
    policy: providerSendPolicy,
    members: Object.entries(units).map(([ordinal, unitKey]) => ({
      ordinal: Number(ordinal),
      unitKey,
      language: "en",
      coordinate:
        Number(ordinal) <= 2 ? "synthetic-one" : Number(ordinal) <= 10 ? "synthetic-two" : `synthetic-${ordinal}`,
    })),
    armed_at: "2026-10-02T00:00:00.000Z",
    refusal: null as ProviderSendRefusal | null,
  };
  const quotas = providerSendInstalledQuotas().map((quota) => ({
    ...quota,
    used: quota.pass === pass && quota.bucket === "non-scrydex" ? nonScrydexUsed : 0,
  }));
  const events: string[] = [];
  const attempts: unknown[][] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      events.push(sql);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT window_id FROM catalog_provider_send_authority"))
      return { rows: [{ window_id: row.window_id }] };
    if (sql.startsWith("SELECT window_id, phase")) return { rows: [{ ...row }] };
    if (sql.startsWith("SELECT pass, bucket")) return { rows: quotas.map((quota) => ({ ...quota })) };
    if (sql.startsWith("UPDATE catalog_provider_send_quotas")) {
      const quota = quotas.find((quota) => quota.pass === values[1] && quota.bucket === values[2]);
      if (!quota || quota.quota !== values[3] || quota.used >= quota.quota) return { rows: [] };
      events.push("debit");
      return { rows: [{ used: ++quota.used }] };
    }
    if (sql.startsWith("UPDATE catalog_provider_send_windows SET used")) {
      row.used = Number(values[1]);
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE catalog_provider_send_windows SET state")) {
      row.state = "terminal";
      row.refusal ??= values[1] as ProviderSendRefusal;
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO catalog_provider_send_attempts")) {
      attempts.push([...values]);
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE catalog_provider_send_attempts")) return { rows: [{ sequence: values[1] }] };
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as PgTransactionalPool;
  return { ledger: createPostgresProviderSendLedger(pool), row, quotas, events, attempts, query };
}

function continuation(nextPage: string) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> =>
    Response.json(fetch.mock.calls.length === 1 ? { data: [], next_page: nextPage } : { data: [] }),
  );
  const registry = new ProviderAdapterRegistry([
    createScrydexOnePieceProviderAdapter({
      credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
      baseUrl: "https://synthetic-onepiece.invalid/onepiece/v1",
      lorcanaBaseUrl: "https://synthetic-lorcana.invalid/lorcana/v1",
      fetch,
    }),
  ]);
  const work = () =>
    registry.require("scrydex").listOptions({
      unitKey: "scrydex:lorcana:single-card:source-observation-import",
      optionKind: "cards",
      parentValues: { expansionId: "synthetic-one", language: "en" },
    });
  return { fetch, work };
}

describe("Catalog armed destination admission", () => {
  it.each([
    "https://synthetic-untrusted.invalid/lorcana/v1/cards?page=2",
    "//synthetic-untrusted.invalid/lorcana/v1/cards?page=2",
    "https://synthetic-onepiece.invalid/lorcana/v1/cards?page=2",
  ])("refuses foreign-origin continuation %s before forwarding credentials", async (nextPage) => {
    const fixture = installedLedger();
    const admission = createProviderSendAdmission({ enabled: true, ledger: fixture.ledger });
    const { fetch, work } = continuation(nextPage);
    await expect(runCatalogProviderWork(admission, work)).rejects.toMatchObject({
      name: "ProviderSendStoppedError",
      code: "unknown-request",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).origin).toBe("https://synthetic-lorcana.invalid");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Api-Key")).toBe("synthetic-key");
    expect(fixture.row).toMatchObject({ state: "terminal", refusal: "unknown-request", used: 1 });
    expect(fixture.attempts).toHaveLength(1);
  });

  it.each(["cards?page=2", "https://synthetic-lorcana.invalid/lorcana/v1/cards?page=2"])(
    "preserves same-origin continuation %s",
    async (nextPage) => {
      const fixture = installedLedger();
      const { fetch, work } = continuation(nextPage);
      await runCatalogProviderWork(createProviderSendAdmission({ enabled: true, ledger: fixture.ledger }), work);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fixture.row).toMatchObject({ state: "armed", refusal: null, used: 2 });
    },
  );

  it.each([false, true])("preserves legacy continuation with enabled=%s and no armed binding", async (enabled) => {
    const fixture = installedLedger();
    const debit = vi.fn(async () => ({ state: "unarmed" as const }));
    const admission = createProviderSendAdmission({
      enabled,
      ledger: { ...fixture.ledger, bind: async () => null, debit },
    });
    const { fetch, work } = continuation("https://synthetic-untrusted.invalid/lorcana/v1/cards?page=2");
    await runCatalogProviderWork(admission, work);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(debit).toHaveBeenCalledTimes(enabled ? 2 : 0);
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("charges approved Scrydex image acquisition to the shared non-Scrydex bucket before fetch", async () => {
    const fixture = installedLedger(1);
    const body = await sharp({ create: { width: 12, height: 16, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(fixture.events.slice(-2)).toEqual(["debit", "COMMIT"]);
      expect(fixture.attempts).toEqual([
        [fixture.row.window_id, 1, "pass", 1, "non-scrydex", "catalog-mirror", "asset"],
      ]);
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("X-Api-Key")).toBe(false);
      return new Response(Uint8Array.from(body).buffer, { headers: { "content-type": "image/png" } });
    });
    const asset = await runCatalogProviderWork(
      createProviderSendAdmission({ enabled: true, ledger: fixture.ledger }),
      () => image(fetch),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(asset?.sourcePolicy).toMatchObject({
      sourceProviderKey: "scrydex",
      sourceUrlHost: "synthetic-image.invalid",
    });
    expect(asset?.variants).toHaveLength(6);
    expect(JSON.stringify(asset)).not.toContain("https://synthetic-image.invalid/");
    expect(fixture.row).toMatchObject({ state: "armed", refusal: null, used: 1 });
  });

  it.each(["quota-exhausted", "redirect-refused"] as const)("image %s sends nothing extra", async (code) => {
    const fixture = installedLedger(1, code === "quota-exhausted" ? providerSendPolicy.nonScrydex - 1 : 0);
    const admission = createProviderSendAdmission({ enabled: true, ledger: fixture.ledger });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          null,
          code === "redirect-refused"
            ? { status: 302, headers: { location: "https://synthetic-other.invalid/card.png" } }
            : { status: 404 },
        ),
    );
    if (code === "quota-exhausted")
      await expect(runCatalogProviderWork(admission, () => image(fetch))).rejects.not.toBeInstanceOf(
        ProviderSendStoppedError,
      );
    await expect(runCatalogProviderWork(admission, () => image(fetch))).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.attempts).toHaveLength(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fixture.row).toMatchObject({ state: "terminal", refusal: code });
  });

  it.each([
    "https://synthetic-image.invalid/unknown",
    "https://synthetic-image.invalid/lorcana/v1/cards",
    "https://synthetic-image.invalid/api/card.png",
    "https://api.synthetic-image.invalid/card.png",
    "https://synthetic-user:synthetic-password@synthetic-image.invalid/card.png",
    "https://synthetic-image.invalid/card.png?token=synthetic-token",
  ])("refuses unknown/API/credentialed image destination %s", async (sourceUrl) => {
    const fixture = installedLedger(1);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runCatalogProviderWork(createProviderSendAdmission({ enabled: true, ledger: fixture.ledger }), () =>
        image(fetch, sourceUrl),
      ),
    ).rejects.toMatchObject({ code: "unknown-request" });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.attempts).toHaveLength(0);
    expect(fixture.row).toMatchObject({ state: "terminal", refusal: "unknown-request", used: 0 });
  });
});

function image(
  fetcher: typeof globalThis.fetch,
  sourceUrl = "https://synthetic-image.invalid/lorcana/synthetic-card.png",
) {
  return normalizeLorcanaImageAsset({
    providerKey: "scrydex",
    imageUrls: [sourceUrl],
    observedAt: "2026-10-02T00:00:00.000Z",
    storageBaseKey: "synthetic-assets",
    fetcher,
    assetStorage: {
      putObject: async (input) => ({ key: input.key, publicUrl: `https://synthetic-retained.invalid/${input.key}` }),
    },
  });
}

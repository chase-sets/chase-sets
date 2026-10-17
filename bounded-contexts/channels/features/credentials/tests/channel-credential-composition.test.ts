import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { module as channels } from "../../../index";
import { parseChannelCredentialKeyring } from "../domain/codecs";
import { channelProviderRegistry } from "../../publication-port/api/registry";

it("composes unavailable custody without changing credential-free setup or metadata authority", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const services = channels.createServices({ query, connect: vi.fn() }, { channelSaleRecorder: vi.fn() });
  expect(
    await channelProviderRegistry.setupResolver.resolve({ providerKey: "tcgplayer", environment: "sandbox" }),
  ).toMatchObject({ requirements: { credential: "not-required" } });
  await expect(
    services.credentials.create(
      { query },
      { accountId: "a", connectionId: "c", providerKey: "synthetic", environment: "sandbox" },
      {},
      "2026-09-23T00:00:00Z",
    ),
  ).rejects.toThrow("unavailable");
  expect(query).not.toHaveBeenCalled();
});

it("threads the shared parser and rotated keyring through real API and worker ports", () => {
  const root = new URL("../../../../../", import.meta.url);
  for (const host of ["platform-api", "platform-worker"]) {
    const config = readFileSync(new URL(`deployables/${host}/src/config.ts`, root), "utf8");
    const main = readFileSync(new URL(`deployables/${host}/src/main.ts`, root), "utf8");
    expect(config).toContain("parseChannelCredentialKeyring(process.env.CHANNELS_CREDENTIAL_KEYRING_JSON)");
    expect(main).toContain("channelCredentialKeyring: config.channelCredentialKeyring");
  }
  for (const id of ["old", "new"]) {
    const config = parseChannelCredentialKeyring(
      JSON.stringify({
        activeKeyId: id,
        keys: [
          { keyId: "old", keyBase64: Buffer.alloc(32, 1).toString("base64") },
          { keyId: "new", keyBase64: Buffer.alloc(32, 2).toString("base64") },
        ],
      }),
    );
    expect(config?.activeKeyId).toBe(id);
  }
});

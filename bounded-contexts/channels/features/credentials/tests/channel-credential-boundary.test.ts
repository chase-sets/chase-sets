import { expect, it, vi } from "vitest";
import { createChannelCredentialRuntime } from "../api/runtime";
import { decodeTokenSet, encodeEnvelopeAad, parseChannelCredentialKeyring } from "../domain/codecs";
import { readFileSync, readdirSync } from "node:fs";
import type { PgQueryFunction } from "@chase-sets/event-core-postgres";
import { at, binding, capability, keyring, payload } from "./fixtures";

it("releases bytes only to the exact bound capability; scans metadata, errors and SQL for secret markers", async () => {
  const query = vi.fn<PgQueryFunction>().mockResolvedValue({ rows: [{ row_id: "inserted" }] });
  const consoleLog = vi.spyOn(console, "log");
  const consoleError = vi.spyOn(console, "error");
  try {
    const runtime = createChannelCredentialRuntime(keyring(), [{ capability, binding }]);
    const created = await runtime.create({ query }, binding, payload, at);
    const insert = query.mock.calls[0];
    const values = insert[1]!;
    const sealed = { ...created, iv: values[13], ciphertext: values[14], tag: values[15] };
    query.mockResolvedValue({ rows: [sealed] });
    const expected = { ...binding, reference: created.rowId, tokenGeneration: 1 };
    const bytes = await runtime.resolve({ query }, capability, expected);
    expect(decodeTokenSet(bytes)).toEqual(payload);
    bytes.fill(0);
    const errors: unknown[] = [];
    for (const mutation of [
      { ...sealed, accountId: "foreign" },
      { ...sealed, tokenGeneration: 2 },
      { ...sealed, keyId: "missing" },
      { ...sealed, tag: Buffer.alloc(16) },
    ]) {
      query.mockResolvedValue({ rows: [mutation] });
      try {
        await runtime.resolve({ query }, capability, expected);
        throw new Error("unexpected-release");
      } catch (error) {
        expect(error).toHaveProperty("code");
        errors.push(error);
      }
    }
    query.mockRejectedValue(new Error(payload.accessToken + payload.refresh.token));
    await expect(runtime.resolve({ query }, capability, expected)).rejects.toMatchObject({
      code: "storage-unavailable",
      message: "storage-unavailable",
    });
    const artifact = JSON.stringify({
      metadata: created,
      errors,
      sql: query.mock.calls,
      logs: consoleLog.mock.calls,
      stderr: consoleError.mock.calls,
    });
    for (const marker of [
      payload.accessToken,
      payload.refresh.token,
      Buffer.from(keyring().keys.get("old")!).toString("base64"),
    ])
      expect(artifact).not.toContain(marker);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(() => encodeEnvelopeAad(created)).not.toThrow();
  } finally {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  }
});

it("has exactly one Channels AES implementation and no custody event or artifact writer", () => {
  const root = new URL("../../../", import.meta.url);
  function sources(directory: URL): URL[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", "tests", "__tests__"].includes(entry.name)) return [];
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      return entry.isDirectory()
        ? sources(file)
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
          ? [file]
          : [];
    });
  }
  const ciphers = sources(root).filter((file) => /createCipheriv|createDecipheriv/.test(readFileSync(file, "utf8")));
  expect(ciphers.map((file) => file.pathname.slice(root.pathname.length))).toEqual([
    "support/runtime-support/secret-envelope.ts",
  ]);
  const runtime = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
  expect(runtime).not.toMatch(/writeFile|appendFile|console\.|emit\(|publish\(|appendEvent/);
});

it("default-denies absent and request-shaped capabilities before any read", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const expectation = {
    reference: "credential-1",
    accountId: "account-1",
    connectionId: "connection-1",
    providerKey: "synthetic",
    environment: "sandbox" as const,
    tokenGeneration: 1,
  };
  const keyring = parseChannelCredentialKeyring(
    JSON.stringify({
      activeKeyId: "synthetic",
      keys: [{ keyId: "synthetic", keyBase64: Buffer.alloc(32).toString("base64") }],
    }),
  );
  const capability = Object.freeze({});
  const runtime = createChannelCredentialRuntime(keyring, [{ capability, binding: expectation }]);
  await expect(createChannelCredentialRuntime(keyring).resolve({ query }, capability, expectation)).rejects.toThrow(
    "forbidden",
  );
  await expect(runtime.resolve({ query }, {}, expectation)).rejects.toThrow("forbidden");
  for (const field of ["accountId", "connectionId", "providerKey", "environment"] as const) {
    await expect(runtime.resolve({ query }, capability, { ...expectation, [field]: "foreign" })).rejects.toThrow(
      "forbidden",
    );
  }
  expect(query).not.toHaveBeenCalled();
});

it("keeps secret APIs off the client and custody out of events and authority composition", () => {
  const client = readFileSync(new URL("../../../client.ts", import.meta.url), "utf8");
  const events = readFileSync(new URL("../../connections/domain/contracts.ts", import.meta.url), "utf8");
  const context = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
  expect(client).not.toMatch(/credentials|secret-envelope|TokenSet|Keyring/);
  expect(events).not.toMatch(/accessToken|refreshToken|ciphertext|keyBase64/);
  expect(context).not.toMatch(/credentialResolver:\s*.*credentials/);
  expect(runtime).not.toMatch(/console\.|logger\.|appendEvent|eventStore|status:\s*["']current/);
});

import { describe, expect, it } from "vitest";
import { parseEbayApplicationKeyAuthorityConfiguration } from "../domain/configuration";
import { config, keyFetcher, payload, post, signedApp, signedHeader } from "./signed-fixtures";

describe("ebay-account-deletion-key-config", () => {
  it("keeps credentials optional but refuses partial, malformed or oversized authority without values", () => {
    expect(parseEbayApplicationKeyAuthorityConfiguration("", "", "sandbox")).toBeNull();
    for (const [id, secret] of [
      ["", "synthetic-secret-marker"],
      ["synthetic-client", ""],
      ["bad:id", "secret"],
      ["id", "x".repeat(2049)],
    ]) {
      expect(() => parseEbayApplicationKeyAuthorityConfiguration(id, secret, "sandbox")).toThrow(
        /^ebay_application_key_authority_configuration_invalid$/,
      );
    }
  });
  it("secret-marker scan finds no credential, token, key, subject or notification identity in responses/telemetry", async () => {
    const fixture = signedApp();
    const responses = [await post(fixture.app), await post(fixture.app, payload, "malformed")];
    const failed = signedApp({}, keyFetcher("synthetic-private-key-marker"));
    responses.push(await post(failed.app));
    const text = JSON.stringify([
      await Promise.all(responses.map((r) => r.text())),
      fixture.record.mock.calls,
      failed.record.mock.calls,
    ]);
    for (const marker of [
      config.applicationAuthority.clientId,
      config.applicationAuthority.clientSecret,
      "synthetic-access-token-marker",
      "synthetic-private-key-marker",
      payload.notification.notificationId,
      ...Object.values(payload.notification.data),
      signedHeader(),
    ])
      expect(text).not.toContain(marker);
    expect(fixture.record.mock.calls[0]?.[0]).toMatchObject({ tokenMint: "succeeded", keyFetch: "succeeded" });
    expect(fixture.record.mock.calls[1]?.[0]).toMatchObject({ tokenMint: "not-attempted", keyFetch: "not-attempted" });
    expect(failed.record.mock.lastCall?.[0]).toMatchObject({ tokenMint: "succeeded", keyFetch: "unavailable" });
  });
});

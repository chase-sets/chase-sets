import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveChromeExtensionId } from "../domain/derive-chrome-extension-id";
import {
  TCGPLAYER_CONNECTOR_EXTENSION_ID,
  TCGPLAYER_CONNECTOR_EXTENSION_KEY,
  TCGPLAYER_CONNECTOR_REDIRECT_URI,
} from "../domain/identity";

describe("connector-client-public-surface", () => {
  it("exports exactly the three Chromium-observed constants from ./client and the root", () => {
    const expectedExports = [
      "TCGPLAYER_CONNECTOR_EXTENSION_ID",
      "TCGPLAYER_CONNECTOR_EXTENSION_KEY",
      "TCGPLAYER_CONNECTOR_REDIRECT_URI",
    ];
    const clientSource = readFileSync(resolve(import.meta.dirname, "../../../client.ts"), "utf8");
    const clientExports = [...clientSource.matchAll(/^\s*(TCGPLAYER_[A-Z_]+),?$/gm)].map((match) => match[1]).sort();
    expect(clientExports).toEqual(expectedExports);
    const rootSource = readFileSync(resolve(import.meta.dirname, "../../../index.ts"), "utf8");
    for (const exportName of expectedExports) expect(rootSource).toContain(exportName);
  });

  it("uses derivation only as a cross-check of the observed identity", () => {
    expect(deriveChromeExtensionId(TCGPLAYER_CONNECTOR_EXTENSION_KEY)).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
    expect(TCGPLAYER_CONNECTOR_REDIRECT_URI).toBe(
      `https://${TCGPLAYER_CONNECTOR_EXTENSION_ID}.chromiumapp.org/ucp/oauth/callback`,
    );
  });
});

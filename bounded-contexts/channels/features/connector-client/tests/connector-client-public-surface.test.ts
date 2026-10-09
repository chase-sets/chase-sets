import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { createConnectorBackground } from "../domain/connector-background";
import type {
  ConnectorBackgroundPorts,
  ConnectorCommand,
  ConnectorStatus,
} from "../domain/connector-background-contract";
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

  it("exports only connector contracts and the shared fulfillment composer; a planted reducer is rejected", () => {
    function exports(source: string) {
      const file = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true);
      return file.statements
        .flatMap((statement) => {
          if (
            !ts.isExportDeclaration(statement) ||
            !statement.exportClause ||
            !ts.isNamedExports(statement.exportClause)
          )
            return ["unexpected-statement"];
          return statement.exportClause.elements.map((element) => element.name.text);
        })
        .sort();
    }
    const source = readFileSync(resolve(import.meta.dirname, "../../../client.ts"), "utf8");
    const expected = [
      "TCGPLAYER_CONNECTOR_EXTENSION_ID",
      "TCGPLAYER_CONNECTOR_EXTENSION_KEY",
      "TCGPLAYER_CONNECTOR_REDIRECT_URI",
      "createConnectorBackground",
      "composeChannelOrderFulfillmentReference",
      "composeChannelOrderFulfillmentInbound",
      "translateOrderShippingType",
      "translateOrderStatus",
      "ChannelOrderFulfillmentObservation",
      "createConnectorRetentionStore",
      "ConnectorCommand",
      "ConnectorStatus",
      "ConnectorBackgroundPorts",
      "composeTcgplayerOrderInbound",
      "assertTcgplayerOrderRecord",
      "tcgplayerSaleKey",
      "tcgplayerOrderLimits",
      "composeTcgplayerOrderObservation",
      "TcgplayerOrderRecord",
      "TcgplayerOrderObservation",
      "TcgplayerPullSummary",
      "TcgplayerSaleLine",
    ].sort();
    expect(exports(source)).toEqual(expected);
    expect(exports(`${source}\nexport { reducer } from './private';`)).not.toEqual(expected);
    const composition = (ports: ConnectorBackgroundPorts) => createConnectorBackground(ports);
    const command: ConnectorCommand = { type: "status" };
    const readStatus = async (ports: ConnectorBackgroundPorts): Promise<ConnectorStatus> => composition(ports).status();
    expect(command.type).toBe("status");
    expect(typeof readStatus).toBe("function");
  });

  it("uses derivation only as a cross-check of the observed identity", () => {
    expect(deriveChromeExtensionId(TCGPLAYER_CONNECTOR_EXTENSION_KEY)).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
    expect(TCGPLAYER_CONNECTOR_REDIRECT_URI).toBe(
      `https://${TCGPLAYER_CONNECTOR_EXTENSION_ID}.chromiumapp.org/ucp/oauth/callback`,
    );
  });
});

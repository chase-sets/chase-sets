import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { expect } from "vitest";
import * as contract from "@chase-sets/tcgplayer-market-observations";
import { redactProviderCredentialReadinessEvidence } from "@chase-sets/provider-credentials";
import { OperatorSessionRequestError, readBody } from "../api/request";
import { operatorExtensionContext } from "../api/set-name-observations";
import {
  observationPollVersion,
  operatorEnvironments,
  operatorOrigins,
  parseObservationPoll,
} from "../domain/extension/protocol";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import type { createMarketObservationRoutes } from "../api/market-observations";

export function mutant(needle: string, replacement: string): typeof createMarketObservationRoutes {
  let source = readFileSync(new URL("../api/market-observations.ts", import.meta.url), "utf8");
  expect(source.split(needle), needle).toHaveLength(2);
  source = source.replace(needle, replacement);
  source = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/import[\s\S]*?from "[^"]+";?/g, "")
    .replace(/^export /gm, "");
  const bindings = {
    ...contract,
    observationPollVersion,
    operatorEnvironments,
    operatorOrigins,
    parseObservationPoll,
    resolvePublicRequestOrigin,
    redactProviderCredentialReadinessEvidence,
    OperatorSessionRequestError,
    readBody,
    operatorExtensionContext,
  };
  return new Function(...Object.keys(bindings), `${source}\nreturn createMarketObservationRoutes;`)(
    ...Object.values(bindings),
  );
}

export function bodyReaderWithoutDeadline(): typeof readBody {
  const source = readFileSync(new URL("../api/request.ts", import.meta.url), "utf8");
  const needle = "Promise.race([reader.read(), deadline])";
  expect(source.split(needle)).toHaveLength(2);
  const mutated = stripTypeScriptTypes(source.replace(needle, "(deadline.catch(() => undefined), reader.read())"), {
    mode: "transform",
  }).replace(/^export /gm, "");
  return new Function(`${mutated}\nreturn readBody;`)();
}

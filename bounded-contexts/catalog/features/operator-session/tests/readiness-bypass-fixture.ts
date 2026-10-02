import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { expect } from "vitest";
import * as postgres from "@chase-sets/event-core-postgres";
import * as secrets from "@chase-sets/platform-runtime/secret-envelope";
import * as readiness from "../domain/readiness";
import * as value from "../domain/value";
import * as outcomes from "../api/outcomes";
import * as store from "../api/store";
import * as client from "../../source-observations/api/providers/tcgplayer-automation-client";
import * as admission from "../../source-observations/api/providers/provider-send-admission";
import * as budget from "../domain/rate-budget-context";

// Test-only, source-derived mutants. No product files or shared module bindings are modified.
function bypass<T>(
  path: string,
  needle: string,
  replacement: string,
  count: number,
  symbol: string,
  onBypass: () => void,
): T {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  expect(source.split(needle)).toHaveLength(count + 1);
  const mutated = stripTypeScriptTypes(source.replaceAll(needle, replacement), { mode: "transform" })
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";/g, "")
    .replace(/^export /gm, "");
  const bindings = { ...postgres, ...secrets, ...readiness, ...value, ...outcomes, ...admission, ...budget, onBypass };
  return new Function(...Object.keys(bindings), `${mutated}\nreturn ${symbol};`)(...Object.values(bindings)) as T;
}

export const bypassLiveTuple = (onBypass: () => void) =>
  bypass<typeof outcomes.createOperatorSessionOutcomeRecorder>(
    "../api/outcomes.ts",
    "if (!sameOperatorSessionIdentity(identity, live)) return;",
    "onBypass();",
    1,
    "createOperatorSessionOutcomeRecorder",
    onBypass,
  );

export const bypassCustodyReset = (onBypass: () => void) =>
  bypass<typeof store.createPostgresCatalogOperatorSessionStore>(
    "../api/store.ts",
    "await resetOperatorSessionOutcome({ query });",
    "onBypass();",
    2,
    "createPostgresCatalogOperatorSessionStore",
    onBypass,
  );

export const bypassHeadersCapture = (onBypass: () => void) =>
  bypass<typeof client.TcgplayerAutomationDomainHttpClient>(
    "../../source-observations/api/providers/tcgplayer-automation-client.ts",
    "captured = captureHeaders(attemptIdentity,",
    "onBypass(); captured = captureHeaders(captureAttemptIdentity(await this.configStore.loadConfig()),",
    2,
    "TcgplayerAutomationDomainHttpClient",
    onBypass,
  );

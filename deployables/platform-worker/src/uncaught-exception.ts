import { AssertionError } from "node:assert";
import { writeSync } from "node:fs";
import { inspect } from "node:util";

function isUndiciTlsResponseAssertion(error: Error): boolean {
  if (!(error instanceof AssertionError) || error.code !== "ERR_ASSERTION" || error.message !== "false == true") {
    return false;
  }

  const [, parserFrame = "", socketFrame = ""] = error.stack?.split("\n", 3) ?? [];
  return (
    /^\s+at Parser\.finish \(node:internal\/deps\/undici\/undici:\d+:\d+\)$/.test(parserFrame) &&
    /^\s+at TLSSocket\.onHttpSocketEnd \(node:internal\/deps\/undici\/undici:\d+:\d+\)$/.test(socketFrame)
  );
}

process.on("uncaughtException", (error, origin) => {
  // Undici throws from the TLS end callback, outside the request's promise chain.
  if (origin === "uncaughtException" && isUndiciTlsResponseAssertion(error)) {
    console.error("[platform-worker] Ignored uncaught undici TLS response assertion", error.stack);
    return;
  }

  // Preserve fatal diagnostics and status without relying on async logging before exit.
  try {
    writeSync(process.stderr.fd, `${inspect(error, { customInspect: false })}\n`);
  } finally {
    process.exit(1);
  }
});

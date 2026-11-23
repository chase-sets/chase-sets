import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const guardUrl = new URL("../src/uncaught-exception.ts", import.meta.url).href;
const workerDirectory = fileURLToPath(new URL("..", import.meta.url));

function runChild(mode: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--unhandled-rejections=strict",
      "--input-type=module",
      "--eval",
      String.raw`
        import { AssertionError } from "node:assert";
        import ${JSON.stringify(guardUrl)};

        const mode = ${JSON.stringify(mode)};
        const error = mode === "ordinary error"
          ? new Error("unrelated failure")
          : new AssertionError({ actual: false, expected: true, operator: "==" });

        if (mode !== "ordinary error") {
          const socket = mode === "plain socket" ? "Socket" : "TLSSocket";
          error.stack = String(error) + "\n" + [
            "    at Parser.finish (node:internal/deps/undici/undici:7449:9)",
            "    at " + socket + ".onHttpSocketEnd (node:internal/deps/undici/undici:7888:34)",
            "    at TLSSocket.emit (node:events:526:24)",
          ].join("\n");
        }

        setImmediate(() => {
          if (mode === "rejection") {
            void Promise.reject(error);
          } else {
            throw error;
          }
        });
        setImmediate(() => console.log("worker still running"));
      `,
    ],
    { cwd: workerDirectory, encoding: "utf8", timeout: 10_000 },
  );
}

it("logs the undici TLS assertion and continues processing callbacks", () => {
  const child = runChild("match");

  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("worker still running");
  expect(child.stderr).toContain("Ignored uncaught undici TLS response assertion");
  expect(child.stderr).toContain("AssertionError [ERR_ASSERTION]: false == true");
  expect(child.stderr).toContain("Parser.finish (node:internal/deps/undici/undici:7449:9)");
  expect(child.stderr).toContain("TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7888:34)");
});

it.each([
  ["ordinary error", "Error: unrelated failure"],
  ["plain socket", "AssertionError [ERR_ASSERTION]: false == true"],
  ["rejection", "AssertionError [ERR_ASSERTION]: false == true"],
])("still exits with status 1 for %s", (mode, message) => {
  const child = runChild(mode);

  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(1);
  expect(child.stdout).not.toContain("worker still running");
  expect(child.stderr).toContain(message);
  expect(child.stderr).not.toContain("Ignored uncaught undici TLS response assertion");
});

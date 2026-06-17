#!/usr/bin/env node
import process from "node:process";
import { runCatalogTcgdexRealProviderProof } from "../bounded-contexts/catalog/features/source-observations/tests/catalog-integration-real-provider-proof.ts";

try {
  const options = parseArgs(process.argv.slice(2), process.env);
  const packet = await runCatalogTcgdexRealProviderProof({
    environment: options.environment,
    checkedAt: options.checkedAt,
    transportMode: options.transportMode,
  });
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Catalog real-provider proof failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Readonly<{
  environment: string;
  checkedAt: string;
  transportMode: "live-provider" | "staging-provider-proof";
}> {
  const transportMode = readOption(argv, "--transport-mode") ?? "live-provider";
  if (transportMode !== "live-provider" && transportMode !== "staging-provider-proof") {
    throw new Error("--transport-mode must be live-provider or staging-provider-proof.");
  }

  return {
    environment:
      readOption(argv, "--environment") ??
      env.CATALOG_REAL_PROVIDER_PROOF_ENVIRONMENT ??
      env.DEPLOYMENT_ENVIRONMENT ??
      "local",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    transportMode,
  };
}

function readOption(argv: readonly string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1).trim() || null;
  }

  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1]?.trim() || null;
  }

  return null;
}

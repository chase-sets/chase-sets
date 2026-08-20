import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildRelease, checkCorpus, checkGrammar, checkRelease, fixtureRoot, proportionality, releasePath, stableJson } from "./authority.mjs";
import { scanTrackedConsumers } from "./recovery-oracle.mjs";
import { verifyTransactionHarness } from "./transaction.mjs";

export function verify(argv = []) {
  if (argv.includes("--write-release")) { const release = buildRelease(); writeFileSync(releasePath, stableJson(release)); return { status: "PASS", receiptDigest: release.receiptDigest }; }
  const proportion = proportionality();
  if (argv.includes("--proportionality")) return { status: "PASS", proportionality: proportion };
  const grammar = checkGrammar(), corpus = checkCorpus(), scan = scanTrackedConsumers();
  if (scan.violations.length) throw new Error("CONSUMER_INDEPENDENCE_FAILED");
  const transactionRoot = mkdtempSync(path.join(tmpdir(), "playwright-authority-transaction-"));
  let transaction;
  try { transaction = verifyTransactionHarness({ source: fixtureRoot, transactionRoot }); }
  finally { rmSync(transactionRoot, { recursive: true, force: true }); }
  const release = checkRelease();
  return { status: "PASS", grammarMembers: grammar.members.length, corpusPayloads: corpus.payloads.length, scannedCandidates: scan.scannedCandidates, transactionCases: transaction.observations.length, receiptDigest: release.receiptDigest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) try { process.stdout.write(`${JSON.stringify(verify(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`authority verification failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`); process.exitCode = 1; }

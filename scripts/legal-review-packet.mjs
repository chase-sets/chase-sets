#!/usr/bin/env node
// The offline counsel review packet CLI.
//
// Two modes, one owner. The default mode writes the deterministic pre-counsel
// packet Markdown to stdout; `--receipt` writes only the closed
// `counsel-review-packet-receipt/v1` JSON record for exactly those bytes. Both
// end with one terminal newline, carry no BOM, embed no generated timestamp,
// and read no wall clock, randomness, environment variable, or credential.
//
// This is a renderer, not an authority. It writes nothing to disk, opens no
// network connection, contacts no counsel, and asserts no approval: the
// operator redirects stdout into a controlled workspace outside the
// repository. Validation runs over the whole in-memory corpus BEFORE a single
// byte is emitted, so a partial packet is unreachable — a failure exits
// nonzero with an empty stdout and bounded key/path diagnostics on stderr.
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildCounselReviewPacketReceipt,
  loadLegalReviewCorpus,
  renderCounselReviewPacket,
  renderCounselReviewPacketReceipt,
} from "./legal-review-corpus.mjs";

const RECEIPT_FLAG = "--receipt";

export function parseLegalReviewPacketArgs(argv) {
  const errors = [];
  let receipt = false;
  for (const argument of argv) {
    if (argument === RECEIPT_FLAG) {
      if (receipt) {
        errors.push(`Counsel review packet option '${RECEIPT_FLAG}' was supplied more than once.`);
      }
      receipt = true;
      continue;
    }
    errors.push(`Counsel review packet does not accept the option '${argument}'.`);
  }
  return { receipt, errors };
}

/**
 * Builds the complete emission for the requested mode, or the ordered
 * diagnostics that stop it. Nothing is written here; the caller owns the one
 * write, so no code path can emit bytes for a corpus that did not validate.
 */
export async function buildLegalReviewPacketEmission(options, dependencies = {}) {
  const load = dependencies.loadLegalReviewCorpus ?? loadLegalReviewCorpus;
  const result = await load();
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  const packet = renderCounselReviewPacket(result.corpus);
  const packetBytes = Buffer.from(packet, "utf8");
  if (!options.receipt) {
    return { ok: true, output: packet, errors: [] };
  }

  const receipt = buildCounselReviewPacketReceipt(result.corpus, packetBytes);
  return { ok: true, output: renderCounselReviewPacketReceipt(receipt), errors: [] };
}

export async function main(argv, io = {}) {
  const write = io.write ?? ((value) => process.stdout.write(value));
  const writeError = io.writeError ?? ((value) => process.stderr.write(`${value}\n`));

  const options = parseLegalReviewPacketArgs(argv);
  if (options.errors.length > 0) {
    for (const error of options.errors) {
      writeError(error);
    }
    return 2;
  }

  const emission = await buildLegalReviewPacketEmission(options, io);
  if (!emission.ok) {
    writeError("Counsel review packet was not generated; the legal review corpus did not validate.");
    for (const error of emission.errors) {
      writeError(error);
    }
    return 1;
  }

  write(emission.output);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}

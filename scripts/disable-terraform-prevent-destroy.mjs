#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: node scripts/disable-terraform-prevent-destroy.mjs <file> [file...]");
  process.exit(1);
}

const preventDestroyBlock = /\r?\n {2}lifecycle \{\r?\n {4}prevent_destroy = true\r?\n {2}\}\r?\n/g;

for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(preventDestroyBlock, "\n");

  if (after === before) {
    console.error(`No standalone prevent_destroy lifecycle block found in ${file}.`);
    process.exitCode = 1;
    continue;
  }

  writeFileSync(file, after);
  console.log(`Disabled prevent_destroy lifecycle block(s) in ${file}.`);
}

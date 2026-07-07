#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function disablePreventDestroyInTerraformContent(content) {
  let disabledCount = 0;
  const withoutPreventDestroy = content.replace(
    /^[ \t]*prevent_destroy[ \t]*=[ \t]*true[ \t]*(?:#.*)?$(?:\r?\n)?/gm,
    () => {
      disabledCount += 1;
      return "";
    },
  );
  const withoutEmptyLifecycleBlocks = withoutPreventDestroy.replace(
    /\r?\n[ \t]*lifecycle[ \t]*\{[ \t]*(?:\r?\n[ \t]*)*\r?\n[ \t]*\}(?=\r?\n|$)/g,
    "\n",
  );

  return {
    content: withoutEmptyLifecycleBlocks,
    disabledCount,
  };
}

export function disablePreventDestroyInTerraformFile(file) {
  const before = readFileSync(file, "utf8");
  const result = disablePreventDestroyInTerraformContent(before);

  if (result.disabledCount === 0) {
    console.error(`No prevent_destroy = true lifecycle setting found in ${file}.`);
    return false;
  }

  writeFileSync(file, result.content);
  console.log(`Disabled prevent_destroy lifecycle setting(s) in ${file}.`);
  return true;
}

function main(argv) {
  const files = argv.slice(2);

  if (files.length === 0) {
    console.error("Usage: node scripts/disable-terraform-prevent-destroy.mjs <file> [file...]");
    process.exit(1);
  }

  let changedAllFiles = true;
  for (const file of files) {
    changedAllFiles = disablePreventDestroyInTerraformFile(file) && changedAllFiles;
  }
  if (!changedAllFiles) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}

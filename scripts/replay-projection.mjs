import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "./scripts/replay-projection.ts", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) {
  console.error("Projection replay wrapper failed.", result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);

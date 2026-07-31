import { asRouteCensusError } from "./errors.mts";
import { evaluateTargetRoot } from "./capture.mts";

async function main(): Promise<void> {
  const targetRoot = process.env.ROUTE_CENSUS_TARGET_ROOT;
  const expectedHead = process.env.ROUTE_CENSUS_EXPECT_HEAD;
  if (!targetRoot || !expectedHead || !process.send)
    throw new Error("Evaluation child environment/IPC is unavailable.");
  try {
    process.send({ ok: true, capture: await evaluateTargetRoot(targetRoot, expectedHead) });
  } catch (error) {
    const normalized = asRouteCensusError(error, "E_CHILD_FAILED");
    process.send({ ok: false, code: normalized.code, message: normalized.message });
    process.exitCode = 2;
  }
}

await main();

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo.mjs";

register("./typescript-extension-loader.mjs", import.meta.url);

const outputRoot = path.join(repoRoot, "docs", "api", "agent-connectors");
const checkMode = process.argv.includes("--check");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeOrCheck(relativePath, value) {
  const targetPath = path.join(outputRoot, relativePath);
  const content = stableJson(value);
  if (checkMode) {
    const existing = await readFile(targetPath, "utf8").catch(() => null);
    if (existing !== content) {
      throw new Error(
        `${path.relative(repoRoot, targetPath)} is stale. Run pnpm run generate:agent-connector-packaging.`,
      );
    }
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

export async function generateAgentConnectorPackaging() {
  const { buildAgentConnectorPackaging } =
    await import("../infrastructure/platform-runtime/agent-connector-packaging.ts");
  const packaging = buildAgentConnectorPackaging();
  await writeOrCheck("native-mcp-registration.json", packaging.registration);
  await writeOrCheck("claude-directory.manifest.json", packaging.manifests["claude-directory"]);
  await writeOrCheck("chatgpt-app.manifest.json", packaging.manifests["chatgpt-app"]);
  await writeOrCheck("gemini.manifest.json", packaging.manifests.gemini);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateAgentConnectorPackaging();
  console.log(
    checkMode ? "Agent connector packaging artifacts are current." : "Generated agent connector packaging artifacts.",
  );
}

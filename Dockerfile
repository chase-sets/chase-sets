# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS manifests

WORKDIR /app

# Collect only the workspace package manifests so the dependency layer below is
# keyed on manifest content, not on source files. This stage re-runs on every
# commit, but its output only changes when a package.json changes, so the
# downstream COPY --from stays cache-stable across source-only changes.
COPY . .
RUN mkdir /manifests \
  && find . -mindepth 3 -maxdepth 3 -name package.json | tar -cf - -T - | tar -xf - -C /manifests

FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN npm install -g pnpm@11.0.9

# Dependency layer: only lockfile, workspace config, or package manifest
# changes invalidate this full pnpm install, so source-only changes reuse it
# from cache. This must stay a real `pnpm install` (not `pnpm fetch`): an
# install over a fetch-seeded virtual store emits bin shims without the
# NODE_PATH preamble that exposes pnpm's hoisted node_modules/.pnpm/node_modules
# directory, which broke sharp's platform binary resolution at runtime
# (issue #1417).
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node --from=manifests /manifests ./
RUN pnpm install --frozen-lockfile

COPY --chown=node:node tsconfig.json tsconfig.base.json tsconfig.vitest.json tailwind.config.ts ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node infrastructure ./infrastructure
COPY --chown=node:node packages ./packages
COPY --chown=node:node bounded-contexts ./bounded-contexts
COPY --chown=node:node deployables ./deployables

RUN pnpm --filter @chase-sets/app-public-web run build \
  && pnpm --filter @chase-sets/app-marketplace-web run build \
  && pnpm --filter @chase-sets/app-admin-web run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN npm install -g pnpm@11.0.9 \
  && chown node:node /app

ENV HOME=/home/node

USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node --from=manifests /manifests ./
RUN pnpm install --frozen-lockfile --prod

COPY --chown=node:node tsconfig.json tsconfig.base.json tsconfig.vitest.json ./
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node infrastructure ./infrastructure
COPY --chown=node:node packages ./packages
COPY --chown=node:node bounded-contexts ./bounded-contexts
COPY --chown=node:node deployables ./deployables
COPY --chown=node:node --from=build /app/deployables/public-web/build ./deployables/public-web/build
COPY --chown=node:node --from=build /app/deployables/marketplace/build ./deployables/marketplace/build
COPY --chown=node:node --from=build /app/deployables/admin-web/build ./deployables/admin-web/build
COPY --chown=node:node scripts/discovery-search-identity-terms-populate.mjs ./scripts/discovery-search-identity-terms-populate.mjs
COPY --chown=node:node scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest ./scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest

RUN find contracts infrastructure packages bounded-contexts deployables \
    -type d \( -name __tests__ -o -name tests -o -name e2e -o -name coverage -o -name .turbo \) -prune -exec rm -rf {} + \
  && find contracts infrastructure packages bounded-contexts deployables \
    -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "vitest.config.*" \) -delete \
  && find deployables packages bounded-contexts contracts infrastructure \
    -type f \( -name "vite.config.*" -o -name "react-router.config.*" \) -delete

ENV NODE_ENV=production

RUN --mount=type=bind,source=scripts/discovery-search-identity-terms-populate.mjs,target=/build-input/scripts/discovery-search-identity-terms-populate.mjs \
    --mount=type=bind,source=scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest,target=/build-input/scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest \
    node --experimental-import-meta-resolve --input-type=module - /build-input <<'POPULATION_IMAGE_ASSERT'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entrypoint = "scripts/discovery-search-identity-terms-populate.mjs";
const manifest = "scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest";
const assets = [entrypoint, manifest];
const shippedFiles = readdirSync("scripts", { recursive: true })
  .filter((name) => statSync(resolve("scripts", name)).isFile())
  .map((name) => `scripts/${name.replaceAll("\\", "/")}`);
assert.deepEqual(shippedFiles.sort(), [...assets].sort(), "Only population assets may ship under scripts");
for (const asset of assets) {
  const content = readFileSync(asset);
  assert.ok(content.equals(readFileSync(resolve(process.argv[2], asset))), `${asset}: build input differs`);
  if (process.getuid) assert.equal(statSync(asset).uid, process.getuid(), `${asset}: must be owned by node`);
  console.log(`Population image asset ${asset} sha256=${createHash("sha256").update(content).digest("hex")}`);
}

const entrypointUrl = pathToFileURL(resolve(entrypoint));
const command = await import(entrypointUrl);
assert.equal(typeof command.parseIdentityTermsPopulationOptions, "function");
assert.equal(typeof command.runIdentityTermsPopulation, "function");
const resolverUrl = new URL("../infrastructure/platform-runtime/typescript-resolver.mjs", entrypointUrl);
const resolver = await import(resolverUrl);
assert.equal(typeof resolver.resolve, "function");
register(resolverUrl);
const rows = readFileSync(manifest, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.deepEqual(rows[0], ["caller", entrypoint]);
const roots = [...new Set(rows
  .filter(([kind, field, edge]) => kind === "candidate" && field === "edges" && edge.from === entrypoint)
  .map(([, , edge]) => edge.specifier))];
const modules = new Map();
for (const specifier of roots) {
  modules.set(specifier, await import(import.meta.resolve(specifier, entrypointUrl.href)));
}
for (const [specifier, name] of [
  ["pg", "Pool"],
  ["../infrastructure/platform-runtime/control-plane.ts", "createPostgresPlatformControlPlane"],
  ["../bounded-contexts/discovery/support/runtime-support/search-identity-terms-population.ts", "populateDiscoverySearchIdentityTerms"],
]) {
  assert.equal(typeof modules.get(specifier)?.[name], "function", `${specifier}: missing ${name}`);
}
console.log(`Population image native import assertion passed (${roots.length} manifest caller roots; no main or connections)`);
POPULATION_IMAGE_ASSERT

EXPOSE 8080

CMD ["pnpm", "--filter", "@chase-sets/app-public-web", "run", "start"]

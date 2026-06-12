FROM node:24-bookworm-slim AS manifests

WORKDIR /app

# Collect only the workspace package manifests so the dependency layer below is
# keyed on manifest content, not on source files. This stage re-runs on every
# commit, but its output only changes when a package.json changes, so the
# downstream COPY --from stays cache-stable across source-only changes.
COPY . .
RUN mkdir /manifests \
  && find . -mindepth 3 -maxdepth 3 -name package.json | tar -cf - -T - | tar -xf - -C /manifests

FROM node:24-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@11.0.9

# Dependency layer: only lockfile, workspace config, or package manifest
# changes invalidate this full pnpm install, so source-only changes reuse it
# from cache. This must stay a real `pnpm install` (not `pnpm fetch`): an
# install over a fetch-seeded virtual store emits bin shims without the
# NODE_PATH preamble that exposes pnpm's hoisted node_modules/.pnpm/node_modules
# directory, which broke sharp's platform binary resolution at runtime
# (issue #1417).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --from=manifests /manifests ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json tailwind.config.ts ./
COPY scripts ./scripts
COPY contracts ./contracts
COPY infrastructure ./infrastructure
COPY packages ./packages
COPY bounded-contexts ./bounded-contexts
COPY deployables ./deployables

RUN pnpm run sync:workspace-metadata \
  && pnpm --filter @chase-sets/app-public-web run build \
  && pnpm --filter @chase-sets/app-marketplace-web run build \
  && pnpm --filter @chase-sets/app-admin-web run build \
  && pnpm --filter @chase-sets/app-platform-api run build \
  && pnpm --filter @chase-sets/app-platform-worker run build \
  && pnpm --filter @chase-sets/app-admin-support-api run build \
  && pnpm --filter @chase-sets/app-admin-support-worker run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "--filter", "@chase-sets/app-public-web", "run", "start"]

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

RUN find contracts infrastructure packages bounded-contexts deployables \
    -type d \( -name __tests__ -o -name tests -o -name e2e -o -name coverage -o -name .turbo \) -prune -exec rm -rf {} + \
  && find contracts infrastructure packages bounded-contexts deployables \
    -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "vitest.config.*" \) -delete \
  && find deployables packages bounded-contexts contracts infrastructure \
    -type f \( -name "vite.config.*" -o -name "react-router.config.*" \) -delete

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "--filter", "@chase-sets/app-public-web", "run", "start"]

FROM node:24-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@11.0.9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json tailwind.config.ts ./
COPY scripts ./scripts
COPY contracts ./contracts
COPY infrastructure ./infrastructure
COPY packages ./packages
COPY bounded-contexts ./bounded-contexts
COPY deployables ./deployables

RUN pnpm install --frozen-lockfile \
  && pnpm run sync:workspace-metadata \
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

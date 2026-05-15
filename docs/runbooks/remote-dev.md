# Remote DigitalOcean Dev Sessions

Remote dev sessions are disposable DigitalOcean Droplets for branch-level Codex work and real HTTPS preview URLs. They are dev/preview infrastructure only; staging and production deployment are intentionally separate.

GitHub Actions creates App Platform PR preview environments for repository pull requests. Remote dev sessions are an additional branch-level path for human review over HTTPS or remote Codex work when a disposable Droplet is more useful than the automatic PR preview. Keep them bounded with explicit TTLs and cleanup.

## Prerequisites

Install these locally:

- `doctl`
- `ssh`
- `git`
- `pnpm`
- `rsync` for `sync` and `sync-from`

Set these environment variables outside the repo:

```bash
export DIGITALOCEAN_ACCESS_TOKEN=...
export REMOTE_DEV_DOMAIN=dev.example.com
export REMOTE_DEV_DNS_ZONE=example.com
export REMOTE_DEV_SSH_KEY_ID=...
export REMOTE_DEV_SSH_PUBLIC_KEY_PATH="$HOME/.ssh/id_ed25519.pub"
export REMOTE_DEV_SSH_CIDR="203.0.113.10/32"
export REMOTE_DEV_BASIC_AUTH_USER=...
export REMOTE_DEV_BASIC_AUTH_HASH=...
```

`REMOTE_DEV_BASIC_AUTH_PASSWORD` can be used instead of `REMOTE_DEV_BASIC_AUTH_HASH` when Caddy is available locally to generate a hash. Prefer the hash for repeatable automation.

Optional:

```bash
export REMOTE_DEV_SECRET_ENV_PATH="$HOME/.config/chase-sets/remote-dev.env"
export REMOTE_DEV_REGION=nyc3
export REMOTE_DEV_SIZE=s-2vcpu-4gb
export REMOTE_DEV_TTL_HOURS=48
export REMOTE_DEV_CADDY_EMAIL=you@example.com
```

`REMOTE_DEV_SSH_CIDR` is required. Use a narrow operator IP range such as
`x.x.x.x/32`; the tooling intentionally refuses to create previews with SSH
open to the internet.

Delegate the configured `REMOTE_DEV_DOMAIN` to DigitalOcean DNS before creating sessions.
If DigitalOcean manages the apex domain, set `REMOTE_DEV_DNS_ZONE` to that apex zone. For example, use `REMOTE_DEV_DOMAIN=dev.chasesets.com` and `REMOTE_DEV_DNS_ZONE=chasesets.com` so session records are created as `<slug>.dev` and `*.<slug>.dev` inside the `chasesets.com` zone.

## Lifecycle

Preview the DigitalOcean operations without creating resources:

```bash
pnpm run remote-dev -- create --dry-run
```

Create a session for the current branch:

```bash
pnpm run remote-dev -- create
```

Useful commands:

```bash
pnpm run remote-dev -- list
pnpm run remote-dev -- status <slug>
pnpm run remote-dev -- ssh <slug>
pnpm run remote-dev -- open <slug> marketplace
pnpm run remote-dev -- sync <slug>
pnpm run remote-dev -- sync-from <slug>
pnpm run remote-dev -- up <slug>
pnpm run remote-dev -- preview <slug>
pnpm run remote-dev -- logs <slug>
pnpm run remote-dev -- reset-db <slug>
pnpm run remote-dev -- renew <slug> --ttl-hours 48
pnpm run remote-dev -- destroy <slug> --force
pnpm run remote-dev -- prune-expired --force
```

`create` defaults to:

- region `nyc3`
- image `ubuntu-24-04-x64`
- size `s-2vcpu-4gb`
- TTL `48` hours
- hot-reload dev runtime after bootstrap

The session name is generated from branch, short SHA, and a random suffix. Pass `--name <slug>` to choose one.

GitHub Actions can create label-gated PR previews through
`.github/workflows/platform-preview.yml`. Add the `preview` label to create or
refresh one preview session for a same-repository PR; closing the PR destroys
it. Forked PRs do not receive DigitalOcean credentials. A scheduled prune runs
every six hours as a TTL backstop.

## URLs

Each session gets:

- `https://portal.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://marketplace.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://admin.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://api.<slug>.<REMOTE_DEV_DOMAIN>`

Caddy terminates HTTPS and routes `/api/*` from the web hostnames to `platform-api`. Human-facing routes are protected by Basic Auth. Provider webhook paths remain unauthenticated so Stripe test-mode webhooks can reach the API.

## Codex And Git

The Droplet installs Node 24 LTS, pnpm, and the latest Codex CLI during cloud-init. Run this after SSHing into a session:

```bash
codex --login
```

The create flow clones through SSH with agent forwarding. No GitHub token is stored on the Droplet by default. Use `gh auth login` inside a session only when you intentionally want that session to push branches or create PRs.

Use `sync` to copy local WIP to the Droplet and `sync-from` before destroying a session with unpushed work.

## Data And Providers

Sessions use Docker Postgres on the Droplet and run the existing platform bootstrap/seed path. `reset-db` destroys and reseeds the local Docker volume.

Fake payments and money movement plus sandbox postage are the default. To test Stripe, put test-mode values in `REMOTE_DEV_SECRET_ENV_PATH`:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Then configure Stripe test webhook endpoints:

- `https://api.<slug>.<domain>/api/payments/provider/webhooks`
- `https://api.<slug>.<domain>/api/settlement/provider/money-movement/webhooks`

Run the existing smoke checks with `PLATFORM_API_BASE_URL=https://api.<slug>.<domain>`.

Live provider credentials should not be used in remote dev sessions.

## Cleanup And Safety

DigitalOcean tags and resource names are canonical. Local files under `artifacts/remote-dev/` are only a convenience cache.

The tooling warns when more than three active sessions exist. Use `--force` when intentional.

`prune-expired` reads expiration tags from DigitalOcean and destroys expired sessions. The preview workflow runs it on a schedule; run it manually when cleaning up local experiments:

```bash
pnpm run remote-dev -- prune-expired --force
```

Destroy is intentionally explicit:

```bash
pnpm run remote-dev -- destroy <slug> --force
```

# Remote DigitalOcean Dev Sessions

Remote dev sessions are disposable DigitalOcean Droplets for branch-level Codex work and real HTTPS preview URLs. They are dev/preview infrastructure only; production deployment is intentionally separate.

## Prerequisites

Install these locally:

- `doctl`
- `ssh`
- `git`
- `npm`
- `rsync` for `sync` and `sync-from`

Set these environment variables outside the repo:

```bash
export DIGITALOCEAN_ACCESS_TOKEN=...
export REMOTE_DEV_DOMAIN=dev.example.com
export REMOTE_DEV_SSH_KEY_ID=...
export REMOTE_DEV_SSH_PUBLIC_KEY_PATH="$HOME/.ssh/id_ed25519.pub"
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

Delegate the configured `REMOTE_DEV_DOMAIN` to DigitalOcean DNS before creating sessions.

## Lifecycle

Preview the DigitalOcean operations without creating resources:

```bash
npm run remote-dev -- create --dry-run
```

Create a session for the current branch:

```bash
npm run remote-dev -- create
```

Useful commands:

```bash
npm run remote-dev -- list
npm run remote-dev -- status <slug>
npm run remote-dev -- ssh <slug>
npm run remote-dev -- open <slug> marketplace
npm run remote-dev -- sync <slug>
npm run remote-dev -- sync-from <slug>
npm run remote-dev -- up <slug>
npm run remote-dev -- preview <slug>
npm run remote-dev -- logs <slug>
npm run remote-dev -- reset-db <slug>
npm run remote-dev -- renew <slug> --ttl-hours 48
npm run remote-dev -- destroy <slug> --force
npm run remote-dev -- prune-expired --force
```

`create` defaults to:

- region `nyc3`
- image `ubuntu-24-04-x64`
- size `s-2vcpu-4gb`
- TTL `48` hours
- hot-reload dev runtime after bootstrap

The session name is generated from branch, short SHA, and a random suffix. Pass `--name <slug>` to choose one.

## URLs

Each session gets:

- `https://portal.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://marketplace.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://admin.<slug>.<REMOTE_DEV_DOMAIN>`
- `https://api.<slug>.<REMOTE_DEV_DOMAIN>`

Caddy terminates HTTPS and routes `/api/*` from the web hostnames to `platform-api`. Human-facing routes are protected by Basic Auth. Provider webhook paths remain unauthenticated so Stripe test-mode webhooks can reach the API.

## Codex And Git

The Droplet installs the latest Codex CLI with npm. Run this after SSHing into a session:

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

`prune-expired` reads expiration tags from DigitalOcean and destroys expired sessions. Run it regularly:

```bash
npm run remote-dev -- prune-expired --force
```

Destroy is intentionally explicit:

```bash
npm run remote-dev -- destroy <slug> --force
```

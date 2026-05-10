#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${CHASE_SETS_APP_DIR:-/opt/chase-sets/app}"
ENV_DIR="/etc/chase-sets"
ENV_FILE="${ENV_DIR}/remote-dev.env"
SYSTEMD_DIR="/etc/systemd/system"

log() {
  printf '[remote-dev] %s\n' "$*"
}

require_app() {
  if [ ! -d "$APP_DIR/.git" ]; then
    log "Repository not found at $APP_DIR. Run bootstrap first."
    exit 1
  fi
}

install_env_and_caddy() {
  install -d "$ENV_DIR"
  if [ -f /tmp/chase-sets-remote-dev.env ]; then
    install -m 0600 /tmp/chase-sets-remote-dev.env "$ENV_FILE"
  fi
  if [ -f /tmp/chase-sets-Caddyfile ]; then
    install -m 0644 /tmp/chase-sets-Caddyfile /etc/caddy/Caddyfile
    caddy fmt --overwrite /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
}

bootstrap() {
  local repo_url="${1:?repo url required}"
  local branch="${2:?branch required}"
  local slug="${3:?session slug required}"

  install -d -o codex -g codex "$(dirname "$APP_DIR")"
  if [ ! -d "$APP_DIR/.git" ]; then
    sudo --preserve-env=SSH_AUTH_SOCK -Eu codex git clone --branch "$branch" "$repo_url" "$APP_DIR"
  else
    sudo --preserve-env=SSH_AUTH_SOCK -Eu codex git -C "$APP_DIR" fetch origin "$branch"
    sudo --preserve-env=SSH_AUTH_SOCK -Eu codex git -C "$APP_DIR" checkout "$branch"
    sudo --preserve-env=SSH_AUTH_SOCK -Eu codex git -C "$APP_DIR" pull --ff-only origin "$branch"
  fi

  install_env_and_caddy
  install -d -o codex -g codex "$APP_DIR/artifacts/observability"
  log "Installing pnpm dependencies."
  sudo -u codex bash -lc "cd '$APP_DIR' && pnpm install --frozen-lockfile"
  log "Bootstrapping database."
  systemctl enable --now docker
  sudo -u codex bash -lc "cd '$APP_DIR' && set -a && [ -f '$ENV_FILE' ] && source '$ENV_FILE'; set +a; pnpm run dev:bootstrap"
  log "Session $slug is ready. Run: codex --login"
}

write_service() {
  local name="$1"
  local command="$2"
  cat > "${SYSTEMD_DIR}/${name}.service" <<SERVICE
[Unit]
Description=Chase Sets ${name}
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=codex
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=FORCE_COLOR=1
ExecStart=/bin/bash -lc '${command}'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE
}

stop_app_services() {
  systemctl stop chase-sets-dev.service chase-sets-platform-api.service chase-sets-platform-worker.service chase-sets-marketplace.service chase-sets-admin-web.service chase-sets-portal.service 2>/dev/null || true
}

up_dev() {
  require_app
  stop_app_services
  write_service "chase-sets-dev" "set -a; [ -f '${ENV_FILE}' ] && source '${ENV_FILE}'; set +a; pnpm run dev"
  systemctl daemon-reload
  systemctl enable --now chase-sets-dev.service
}

up_preview() {
  require_app
  stop_app_services
  log "Building workspace preview."
  sudo -u codex bash -lc "cd '$APP_DIR' && pnpm run build"
  write_service "chase-sets-platform-api" "pnpm --dir '${APP_DIR}' --filter @chase-sets/app-platform-api run start"
  write_service "chase-sets-platform-worker" "pnpm --dir '${APP_DIR}' --filter @chase-sets/app-platform-worker run start"
  write_service "chase-sets-marketplace" "pnpm --dir '${APP_DIR}' --filter @chase-sets/app-marketplace-web run start"
  write_service "chase-sets-admin-web" "pnpm --dir '${APP_DIR}' --filter @chase-sets/app-admin-web run start"
  write_service "chase-sets-portal" "PORT=6170 node ./scripts/dev-portal.mjs"
  systemctl daemon-reload
  systemctl enable --now chase-sets-platform-api.service chase-sets-platform-worker.service chase-sets-marketplace.service chase-sets-admin-web.service chase-sets-portal.service
}

reset_db() {
  require_app
  stop_app_services
  sudo -u codex bash -lc "cd '$APP_DIR' && set -a && [ -f '$ENV_FILE' ] && source '$ENV_FILE'; set +a; pnpm run dev:db:refresh"
}

logs() {
  local service="${1:-all}"
  if [ "$service" = "all" ]; then
    journalctl -u 'chase-sets-*' -f
  else
    journalctl -u "chase-sets-${service}.service" -f
  fi
}

observability() {
  local action="${1:-up}"
  require_app
  case "$action" in
    up) sudo -u codex bash -lc "cd '$APP_DIR' && pnpm run dev:observability" ;;
    down) sudo -u codex bash -lc "cd '$APP_DIR' && pnpm run dev:observability:down" ;;
    open) sudo -u codex bash -lc "cd '$APP_DIR' && pnpm run dev:observability:open" ;;
    *) log "Unknown observability action: $action"; exit 1 ;;
  esac
}

case "${1:-help}" in
  bootstrap) shift; bootstrap "$@" ;;
  up)
    mode="${2:-dev}"
    case "$mode" in
      dev) up_dev ;;
      preview) up_preview ;;
      *) log "Unknown up mode: $mode"; exit 1 ;;
    esac
    if printf '%s\n' "$@" | grep -q -- '--observability'; then
      observability up
    fi
    ;;
  reset-db) reset_db ;;
  logs) shift; logs "$@" ;;
  observability) shift; observability "$@" ;;
  help|*)
    cat <<'HELP'
Usage:
  chase-sets-remote-dev bootstrap <repo-url> <branch> <slug>
  chase-sets-remote-dev up dev [--observability]
  chase-sets-remote-dev up preview [--observability]
  chase-sets-remote-dev reset-db
  chase-sets-remote-dev logs [service]
  chase-sets-remote-dev observability <up|down|open>
HELP
    ;;
esac

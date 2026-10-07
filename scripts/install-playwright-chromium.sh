#!/usr/bin/env bash
set -euo pipefail

# Budgets can only be shortened, for real-process controls without installing browsers.
attempt_seconds="${PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS:-180}"
grace_seconds="${PLAYWRIGHT_INSTALL_GRACE_SECONDS:-5}"
delay_seconds="${PLAYWRIGHT_INSTALL_DELAY_SECONDS:-5}"
overall_seconds="${PLAYWRIGHT_INSTALL_OVERALL_SECONDS:-390}"
for setting in attempt_seconds grace_seconds delay_seconds overall_seconds; do
  value="${!setting}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Playwright Chromium install failed: invalid ${setting}" >&2
    exit 1
  fi
done
if (( attempt_seconds > 180 || grace_seconds > 5 || delay_seconds > 5 || overall_seconds > 390 || overall_seconds <= grace_seconds )); then
  echo "Playwright Chromium install failed: invalid install budgets" >&2
  exit 1
fi
if [[ "${PLAYWRIGHT_BROWSERS_PATH:-}" != /* ]]; then
  echo "Playwright Chromium install failed: browser path must be absolute" >&2
  exit 1
fi
if ! pnpm_path="$(command -v pnpm)"; then
  echo "Playwright Chromium install failed: pnpm is unavailable" >&2
  exit 1
fi

# Run the installer as root so apt never creates a nested sudo/PTY session.
# The Linux subreaper also owns orphaned/detached children; signals alone to a
# process group cannot prove cleanup of privileged or reparented descendants.
set +e
timeout --signal=TERM --kill-after="${grace_seconds}s" "$((overall_seconds - grace_seconds))s" \
  sudo -n -- env "PATH=${PATH}" "HOME=${HOME}" "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}" \
  python3 - "$pnpm_path" "$attempt_seconds" "$grace_seconds" "$delay_seconds" "$overall_seconds" <<'PY' &
import ctypes
import os
import signal
import sys
import time

pnpm, attempt_seconds, grace_seconds, delay_seconds, overall_seconds = sys.argv[1:]
attempt_seconds, grace_seconds, delay_seconds, overall_seconds = map(
    int, (attempt_seconds, grace_seconds, delay_seconds, overall_seconds)
)
deadline = time.monotonic() + overall_seconds
cancelled = False


def cancel(signum, frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)
signal.signal(signal.SIGHUP, cancel)
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    sys.exit("Playwright Chromium install failed: cannot establish child ownership")


def children(pid):
    try:
        with open(f"/proc/{pid}/task/{pid}/children", encoding="ascii") as source:
            return [int(value) for value in source.read().split()]
    except FileNotFoundError:
        return []


def owned_children():
    pending = children(os.getpid())
    owned = []
    while pending:
        pid = pending.pop()
        owned.append(pid)
        pending.extend(children(pid))
    return owned


def still_owned(pid):
    while pid != os.getpid():
        try:
            with open(f"/proc/{pid}/stat", encoding="ascii") as source:
                pid = int(source.read().rsplit(")", 1)[1].split()[1])
        except FileNotFoundError:
            return False
        if pid <= 1:
            return False
    return True


def reap(primary):
    result = None
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return result
        if pid == 0:
            return result
        if pid == primary:
            result = os.waitstatus_to_exitcode(status)


def cleanup(primary):
    end = min(time.monotonic() + grace_seconds, deadline)
    hard_kill_at = min(time.monotonic() + grace_seconds / 2, end)
    while True:
        reap(primary)
        owned = owned_children()
        if not owned:
            return True
        now = time.monotonic()
        for pid in owned:
            try:
                descriptor = os.pidfd_open(pid)
                try:
                    if still_owned(pid):
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL if now >= hard_kill_at else signal.SIGTERM)
                finally:
                    os.close(descriptor)
            except ProcessLookupError:
                pass
            except OSError:
                return False
        if now >= end:
            reap(primary)
            return not owned_children()
        time.sleep(min(0.05, end - now))


def fail(reason, code=1):
    print(f"Playwright Chromium install failed: {reason}", file=sys.stderr, flush=True)
    return code if 0 < code < 126 else 1


def install():
    for attempt in (1, 2):
        if cancelled:
            return fail(f"attempt {attempt}: external cancellation", 130)
        if time.monotonic() >= deadline - grace_seconds:
            return fail(f"attempt {attempt}: overall deadline")
        print(f"Playwright Chromium install attempt {attempt}/2", flush=True)
        primary = os.fork()
        if primary == 0:
            os.setsid()
            os.execv(pnpm, [pnpm, "exec", "playwright", "install", "--with-deps", "chromium"])
        attempt_end = min(time.monotonic() + attempt_seconds, deadline - grace_seconds)
        result = None
        while not cancelled and time.monotonic() < attempt_end:
            result = reap(primary)
            if result is not None:
                break
            time.sleep(0.05)
        if not cleanup(primary):
            return fail(f"attempt {attempt}: child cleanup could not be proven")
        if cancelled or (result is not None and result < 0):
            return fail(f"attempt {attempt}: external cancellation", 130)
        if result == 0:
            return 0
        reason = "attempt timeout" if result is None else f"exit {result}"
        print(f"Playwright Chromium install attempt {attempt}/2 failed: {reason}", file=sys.stderr, flush=True)
        if attempt == 2:
            return fail(f"attempt {attempt}: {reason}", result or 1)
        delay_end = min(time.monotonic() + delay_seconds, deadline - grace_seconds)
        while not cancelled and time.monotonic() < delay_end:
            time.sleep(0.05)
    return fail("install exhausted")


try:
    sys.exit(install())
except Exception as error:
    clean = cleanup(-1)
    sys.exit(fail(f"supervisor {type(error).__name__}; child cleanup {'proven' if clean else 'unproven'}"))
PY
supervisor=$!
cancel_install() {
  trap - TERM INT HUP
  kill -TERM "$supervisor" 2>/dev/null || true
  wait "$supervisor"
  echo "Playwright Chromium install failed: external cancellation" >&2
  exit 130
}
trap cancel_install TERM INT HUP
wait "$supervisor"
status=$?
trap - TERM INT HUP
set -e
if (( status != 0 )); then
  echo "Playwright Chromium install failed: supervisor exit ${status} (deadline or cancellation if signalled)" >&2
fi
exit "$status"

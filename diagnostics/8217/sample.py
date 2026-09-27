#!/usr/bin/env python3
"""Bounded, observation-only process and PostgreSQL sampler."""
import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root-pid", type=int, required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--container")
args = parser.parse_args()
stop = False
signal.signal(signal.SIGTERM, lambda *_: globals().__setitem__("stop", True))
cap = 12 * 1024 * 1024
path = Path(args.output)
path.write_text("")


def read(path):
    try:
        return Path(path).read_text()
    except (OSError, UnicodeError):
        return None


def processes():
    table = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        raw = read(entry / "stat")
        if not raw or ") " not in raw:
            continue
        fields = raw.rsplit(") ", 1)[1].split()
        try:
            table[pid] = {"ppid": int(fields[1]), "comm": raw.split("(", 1)[1].rsplit(") ", 1)[0], "state": fields[0],
                          "utime": int(fields[11]), "stime": int(fields[12]),
                          "startTicks": int(fields[19]), "rssPages": int(fields[21])}
        except (IndexError, ValueError):
            continue
    owned = {args.root_pid}
    while True:
        more = {pid for pid, row in table.items() if row["ppid"] in owned and pid != os.getpid()}
        if more <= owned:
            break
        owned |= more
    result = []
    for pid in sorted(owned & table.keys()):
        row = table[pid]
        io = read(f"/proc/{pid}/io")
        counters = {}
        for line in (io or "").splitlines():
            key, _, value = line.partition(": ")
            if key in ("read_bytes", "write_bytes", "rchar", "wchar"):
                counters[key] = int(value)
        result.append({"pid": pid, **row, "io": counters})
    return result


def postgres():
    if not args.container:
        return None
    # The observer is one short-lived read-only connection, explicitly excluded.
    query = """BEGIN READ ONLY;
SELECT json_build_object('observer_pid',pg_backend_pid(),
 'states',(SELECT json_agg(x) FROM (SELECT state,coalesce(wait_event_type,'none') AS wait_class,count(*) AS n,
 max(extract(epoch from now()-xact_start)) AS max_xact_age_s
 FROM pg_stat_activity WHERE pid<>pg_backend_pid() GROUP BY 1,2) x),
 'blocked',(SELECT json_agg(x) FROM (SELECT pid,pg_blocking_pids(pid) AS blockers
 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND cardinality(pg_blocking_pids(pid))>0) x));
COMMIT;"""
    try:
        out = subprocess.run(["docker", "exec", args.container, "psql", "-U", "postgres", "-d", "postgres",
                              "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", query],
                             capture_output=True, text=True, timeout=1.5, check=True)
        return json.loads(out.stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        return {"errorClass": type(error).__name__}


def service_cgroup():
    if not args.container:
        return None
    try:
        out = subprocess.run(["docker", "exec", args.container, "sh", "-c",
                              "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/io.stat"],
                             capture_output=True, text=True, timeout=1.5, check=True)
        return out.stdout[:4096]
    except (OSError, subprocess.SubprocessError):
        return None


next_tick = time.monotonic()
with path.open("a", buffering=1) as output:
    while not stop:
        if path.stat().st_size >= cap:
            output.write(json.dumps({"kind": "truncated", "capBytes": cap}) + "\n")
            break
        available = read("/proc/meminfo") or ""
        mem = {k: int(v.split()[0]) for line in available.splitlines()
               if (k := line.partition(":")[0]) in ("MemAvailable", "SwapFree")
               for v in [line.partition(":")[2]]}
        row = {"kind": "sample", "wall": time.time(), "monotonic": time.monotonic(),
               "processes": processes(), "memoryKiB": mem,
               "loadavg": read("/proc/loadavg"), "runnerCpuStat": read("/sys/fs/cgroup/cpu.stat"),
               "runnerIoStat": read("/sys/fs/cgroup/io.stat"),
               "serviceCgroup": service_cgroup(), "postgres": postgres()}
        output.write(json.dumps(row, separators=(",", ":")) + "\n")
        next_tick += 2
        time.sleep(max(0, next_tick - time.monotonic()))
    output.write(json.dumps({"kind": "end", "wall": time.time(), "truncated": path.stat().st_size >= cap}) + "\n")

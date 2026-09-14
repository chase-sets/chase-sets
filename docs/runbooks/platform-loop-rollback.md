# Runbook: roll a milestone back from the platform loop to the host orchestrator

Applies while routine delivery is being moved from the `milestone-orchestrator`
host loop to the orchestration platform loop. One writer per milestone: the
ownership register lives in the container at `.orchestrator/platform-handoff.md`
and is changed only by a Todd comment on #4388.

## Authorization

This document is a procedure, not a standing authorization. Only Todd
authorizes a rollback and only Todd changes milestone ownership (a comment on
#4388 plus the register edit). Reading this runbook is never itself permission
to execute any step below. Before any step in this runbook is carried out as a
separately authorized action, the operator must bind it to the exact run name,
supervisor PID, and worker process identities recorded on the platform
tracking issue — never to a milestone or loop name alone.

## When

The platform run for a milestone has stopped and the loop's own recovery path
(learning note, platform issue, self-loop fix, resume) is not acceptable for
this milestone's timeline, or Todd says so.

## Steps

1. Stop the run on the WSL executor. Find the supervisor PID from the start
   note on the platform tracking issue, or
   `wsl -d Ubuntu -- bash -c 'ps -eo pid,ppid,cmd | grep supervise.mjs'`.
   Kill that process group and confirm no `codex` worker remains.
2. Preserve everything under `/root/orchestration-m2/runtime/<run>` and the
   run's worktree root. Delete nothing; the records are the audit trail.
3. Post the release on #4388 (chase-sets) and on the platform tracking issue,
   naming the milestone, the run, the executor SHA, and the reason. Remove the
   milestone from the container register.
4. Any open platform PR on that milestone becomes an ordinary PR under the
   host loop: exact-head independent review, then normal landing preflight, or
   close and redispatch. Platform attempts are history and do not count
   against the host loop's attempt ceiling.
5. The host loop resumes normal dispatch on the milestone.

## Resuming the platform later

Do not reuse the stopped run name. Start a new run with the same
`targetMilestone` from Windows with `scripts/executor/start-loop.ps1` in the
platform checkout, after moving the executor to the intended `origin/main`
commit while no M2 supervisor is running.

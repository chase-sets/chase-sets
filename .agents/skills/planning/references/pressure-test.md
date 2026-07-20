# Pressure Test — adversarial plan review

Run in a FRESH context (independent agent, different model than the planner —
see model-routing). Input: the drafted milestone/epic/issues. Output: pass, or
concrete repairs. The planner fixes findings before registration; findings are
repairs to drafts, not new scope.

## Rubric

1. **Zero-context implementability** (the real bar). For each issue: could a
   worker with no conversation context implement this correctly from the issue
   text plus its evidence pointers alone? Name the first question such a worker
   would be forced to ask — if one exists, the issue fails.
2. **AC verifiability.** Every AC has an evidence method that actually
   discriminates success from failure. Reject vibes-ACs ("works correctly").
3. **Footprint honesty.** Do the declared footprints match where the change
   must actually land? Missed shared files = rebase collisions; check the
   parallel-wave claims especially.
4. **Decision completeness.** Walk each slice asking "what will the worker have
   to choose?" Any choice not settled in the issue or queued as a decision is a
   finding.
5. **Don't-rebuild.** Does any slice reimplement a shipped surface? Point to
   the prior art the plan missed.
6. **Glossary conformance.** Terms match the owning context's ubiquitous
   language; new terms are flagged for registration.
7. **Scope fences.** Are the non-goals real fences (things a worker might
   plausibly do) or filler?
8. **Chain integrity.** Blocked-by links form a DAG (no cycles), gates are
   checkable, and nothing parked is silently load-bearing.
9. **Day-after steady state.** Any slice introducing or altering a state
   machine or lifecycle: the plan must enumerate the states and name the
   steady one. Ask what routine operation does the day after each transition —
   a machine with only transition states is a finding. (This class escaped two
   full-path code reviews; plan time is the cheapest place to catch an
   omission that is invisible in a diff.)

Report findings ranked by rework-risk: a missed decision or false parallel
claim outranks a fuzzy AC.

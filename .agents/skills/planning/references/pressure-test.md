# Pressure Test — adversarial plan review

Run in a FRESH context (independent agent, different exact model instance than
the planner — see model-routing). Input: the drafted milestone/epic/issues.
Never transfer evidence or a veto from a predecessor model version.

Return `PASS`, `BLOCK_FIXABLE`, or `BLOCK_REPLAN`. Plain `BLOCK` is invalid.
`BLOCK_FIXABLE` means the draft can be repaired without changing the intended
outcome or authority assumptions. `BLOCK_REPLAN` means feasibility, sequencing,
or a required decision/probe must change before drafting can continue. The
planner fixes repairable findings before registration.

Perform one complete sweep; do not stop after the first finding. Give every
finding a stable ID, repo/authority evidence, the exact draft section affected,
a minimal prescribed repair, and the acceptance evidence that distinguishes the
repair. A finding without a bounded remedy is `BLOCK_REPLAN`, not an
aspirational suggestion.

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
10. **Authority-timing.** For every external-authority dependency (GitHub API
    shapes, provider payloads, queue/webhook associations, cloud-API state):
    was the authority probed at the exact moment the implementation will need
    it — not just shown to exist? An unprobed timing assumption is a finding,
    ranked with missed decisions (PR #5883: the merge-queue run's PR
    association is empty until after merge; no implementation could have
    fixed a defect that only a pre-merge probe would have surfaced).
11. **Simplest correct solution.** Construct the strictly smaller plan (fewer
    new modules, abstractions, and evidence artifacts). If it still satisfies
    the outcome and ledger defect constraints, report the plan as too large
    and prescribe that smaller plan as the shrink remedy; the pressure test has
    explicit authority to make this finding.
12. **Evidence proportionality.** An AC that mandates a test architecture or
    artifact rather than an observable property, or an evidence artifact with
    no named ledger defect class justifying it, is a finding. The registered
    prediction is that median mandated-evidence lines per slice will fall while
    ledger defect classes remain covered; review this rule by 2026-09-01.

Report findings ranked by rework-risk: a missed decision, false parallel
claim, or unprobed authority-timing assumption outranks a fuzzy AC.

## Quality-v1 verdict

The twelve rubric items above feed this distinct ordered verdict; they are the
review method, not a second set of semantic requirements. Return all ten keys
in this canonical order using quality-v1's evidence and sole blocking sub-case:

| Key | Evidence to inspect | Blocks only when |
|---|---|---|
| INTENT | Acceptance criteria mapped to executed probes | An acceptance criterion is unmet or has no executed probe |
| CORRECTNESS | Executed reproductions on the exact head | Any confirmed incorrect behavior |
| SECURITY | Threat notes for every touched authorization, input, secret, and data path | Any confirmed exposure |
| SURFACES | Changed public surfaces and the test exercising each | A changed public surface has no test that exercises it |
| SIMPLICITY | Diff against predicted footprint; every new abstraction and its caller count | Footprint is outside the fence or a new abstraction has one caller |
| DEPTH | Public interface added versus the behavior it hides | An internal is exposed across a bounded-context boundary |
| RELIABILITY | Failure modes and steady state for every changed lifecycle | An unhandled state or transition exists in a changed lifecycle |
| PERFORMANCE | Bounds, indexes, and I/O per item for every changed query or loop | An unbounded query or per-item I/O exists on a hot path |
| EXPERIENCE | Loading, empty, error, and success states plus design-system component sources | A state is missing or a component/override is outside the design system |
| LANGUAGE | Every new or renamed public name mapped to its owning glossary or published contract | A public name contradicts the owning glossary or contract |

Taste, style, preference, and unrelated debt never block. For each key return
`PASS`, `BLOCK <finding IDs>`, `NOTE <non-blocking IDs>`, or `N/A <absent
surface>`; presence and shape from `ready-10-quality-surfaces` never substitute
for this semantic judgment. A genuinely new concept without a glossary home is
`BLOCK_REPLAN` under LANGUAGE, never an invented term.

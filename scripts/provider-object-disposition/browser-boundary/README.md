# Installed Browser Boundary

This is the CI-only boundary slice for #8952. It does not authorize an operator
host, a provider window, a secret, or a capture. `assertBrowserAdmission` refuses
operator callers before launching anything. #8364 owns operator authority.

The Static Checks job installs and observes the candidate on an ephemeral
GitHub-hosted `ubuntu-24.04` VM, as its actual sudo-capable runner principal.
Root and host runner processes are trusted administrators; Chromium and its
descendants are not. The AppArmor profile grants namespace construction, not a
firewall. The installed native launcher owns the network/root/handle boundary.

## Protocol

The launcher stays non-dumpable. Each outer or nested seed closes inherited
descriptors and installs an x86-64-only seccomp allowlist before becoming
dumpable. The protected parent maps, checks namespace type/owner/parent, joins,
rereads the maps, kills and reaps that seed. Readiness, reap and total budgets
are respectively 1000, 250 and 1500 milliseconds. Any refusal kills the active
seed without replacing the first error. There is no self-map or unfiltered
fallback. The private root uses bind-self, pivot and old-root detach.

CP-T is the protected transition. CP-A is the final nested-probe admission.
Both exact lines, status zero and empty stderr are required. CP-B is the real
Chromium observation; neither of the earlier checkpoints proves it. Direct
installer probes have their own 5-second deadline and 1-second kill grace.

SF constrains seed syscalls, not peer-side namespace acquisition. B-H1 remains
an accepted hosted-administrator residual: reaping a seed does not revoke a
trusted peer's namespace descriptor or membership. VM disposal is its outer
bound. Operator-host implications remain with #8364.

## Ownership

The launch creates no persistent named host temporary. Kernel-owned private
mounts hold its temporary profile. Caller observations bind launcher/children
by their own PID, parent PID and start time, not by age or name. The installer
never signals a process. Removal validates target/profile/input paths before
mutation, then requires two complete empty ownership censuses. Live, orphaned,
ambiguous, unreadable, capped or missing-key states refuse without deletion.

Success, failure, cancellation and handled shutdown require event-driven owned
drain. No periodic sweep substitutes for terminal cleanup. Runner loss or an
absent cleanup-complete mark means externally disposed/unknown, not cleaned.
The census-to-deletion admission race remains unknown under the bound protocol;
this implementation does not add a lock descriptor or claim atomic removal.

## Proof Status

Native results come only from the candidate's hosted Static Checks job. Local
protocol/ownership tests are synthetic fixture or source-contract evidence.
They are not native feasibility, full acceptance, or controller-release proof.

The initial hosted probe implements restored CP-T/CP-A, CP-B open/close,
exec/descendant labels, PID/start observations and normal owned drain. The
installer includes governing-only network mutation and admission negatives.
The complete AC-D3 matrix is not yet discharged: transition force-kill/stall
controls, hostile seed/FD-import controls, native census stimuli, PID reuse,
concurrent survival, peer holdings, marker propagation and failure restoration
still require dedicated hosted controls. A green subset is not AC-B1..B5 PASS.

## Callers And Ownership

The bound caller census is Packet P in #8951 comment 6031379240. Main did not
contain its historical capture callers. This slice restores only admission and
open/close plus CI setup/removal; it does not import the held branch or its
capture implementation. The retained caller obligations remain:

- Installer and adapter: source binding, CP-T/CP-A parsing and closed diagnostics.
- Capture main: admission before fixtures/credentials and repeated admission.
- Driver: expiry/disposal closes the owned browser.
- CLI and PowerShell wrapper: closed packet validation before atomic publication.
- Component observer and real J: #8954, not this boundary's early checkpoints.
- H2/H3: #8953. Operator installation: #8364. Joint acceptance: #8255.

The boundary alone supplies no parent external-send policy. The bootstrap-only
GET policy and its composition remain required before any capture is usable;
this probe uses memory-only pages and makes no provider request.

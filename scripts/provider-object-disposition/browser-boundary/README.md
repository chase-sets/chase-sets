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

The hosted observer distinguishes pathname checks from Chromium's proc-fdinfo
sandbox root. An ESRCH lookup alone is not absence proof: that root must bind
to the owned init's private proc mount, with stable process and image identities.
Capability observations distinguish the launch user namespace (all sets dropped)
from a proved descendant user namespace. Only the sealed-root Chromium sandbox's
scoped CAP_SYS_ADMIN form is accepted there, with no-new-privileges and no
inheritable or ambient capabilities. Host, unrelated and unreadable namespace
ancestry refuse. Observer namespace descriptors are used only for inspection and
closed in the observer; none is transferred to the workload or its launcher.

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
If metadata disappears mid-census, only a missing stat, or a terminal stat that
is Z/X or flagged exiting (PF_EXITING) with the same PID, start, parent and
kernel flag, proves that record exited. A permission error proves nothing; it is
accepted only when stat is then missing. A live record keeps its latest parent;
replaced and unexplained records still refuse. This shared census governs native
identity observation, the process-tree observer and per-case installation
removal, without retries or new budgets.

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
Hosted controls also check exact setup/launch temporary names and attempt removal
with one and two live browsers, comparing both emitters' complete refusal bytes,
their separate statuses, installation identity and functional browser survival.
A root-only synthetic missing-key stimulus checks census refusal alone and with
a live browser, restores the exact header and requires fresh admission. It is
never part of the workload root. Cleanup completion requires
the exact names and loaded profile to be absent.
Dedicated hosted controls now cover transition KILL/TERM/deadline, hostile seed
syscalls, closed native diagnostics, census/path stimuli, PID-reuse attempts,
concurrent survival, peer holdings, interrupted removal and browser lifecycle.
Each reports its own execution result. Cap construction, PID reuse and peer
access can be refused by the runner; their explicit nonconstruction is not PASS.
Ancestor-path mutation is not performed outside the installation footprint.
The source-bound `path-fixtures.py` executes the shipped installer/wrapper with
only their fixed names rebound in an unprivileged owned tree. Actual realpath
resolution, exact refusals, effect sentinels, equality-only bypass and ordering
mutants distinguish this fixture proof from native installed-ancestor proof.
The hosted case repeats it with a live browser and checks identity and newPage.
The native cap stimulus uses 17 guardian/shard pairs, at most 255 leaf pidfds
plus one shard pidfd per guardian. Atomic clone3 PID/pidfd publication into a
shared ledger and shared FD table retains leaf ownership if the shard dies.
The guardian subreaps and retires only those leaves through their pidfds; EOF
cancels construction/lifetime and the unchanged 2000ms drain bounds retirement.
No inherited resource limit or production census bound is raised.
Control 13 records the readiness-bound L/I1/main-Chromium chain, not every
short-lived Chromium startup helper as a permanent identity. The read-only
`identity-controls.py` discovers that exact parent chain and then rereads only
its recorded PIDs before and after refusal, including start, parent and executable
device/inode. Missing, dead, reparented or replaced identities fail; the baseline
is never refreshed to hide loss. Functional `newPage` and installation/refusal
checks remain separate. The full descendant confinement observer and production
ownership census are unchanged. The synthetic identity-loss negatives exercise
each required role; startup-helper churn is a separate discovery fixture.
The complete AC-D3 matrix is not yet discharged. A green subset is not
AC-B1..B5 PASS; exact-head hosted logs, not this inventory, provide proof.

## Callers And Ownership

The bound caller census is Packet P in #8951 comment 6031379240. Main did not
contain its historical capture callers. This slice restores their boundary
obligations against the currently shipped `captureEvidenceWindow` interface,
not the held branch's capture implementation. The bare entry point refuses:
there is no default private fixture source, credential reader or provider
factory. A trusted sibling-owned composition must supply those closures.

- Installer and adapter: source binding, CP-T/CP-A parsing and closed diagnostics.
- Capture main: operator admission before private closures, repeated admission
  and reviewed-head checks, claim before opening, then boundary before readers.
- Driver: expiry/cancellation closes the owned browser; memoized disposal uses
  the canonical disposition policy and preserves the first error.
- CLI and PowerShell wrapper: closed recursive validation before publication.
  The publisher binds the manifest digest, validates serialized bytes again,
  writes both files exclusively and renames the owned partial directory.
  A claimed failure retains the cleanup obligation, never reports it cleaned.
- Component observer and real J: #8954, not this boundary's early checkpoints.
- H2/H3: #8953. Operator installation: #8364. Joint acceptance: #8255.

The parent transport in `test-window-policy.mjs` admits only the exact serialized
and parsed bootstrap GET, with fixed outgoing headers, no redirects or cookies,
a bounded response and atomic attempts. `openBootstrapPage` loads those bytes in
memory; child routes never grant an external send, including a second bootstrap
request. Contexts are private, offline, service-worker blocked and uncached by
routing. Deadline, cancellation and cap close the owned browser. The required
sender is supplied by the trusted caller; no default network client exists.
Hosted controls use only synthetic responses and make no provider request.
Native direct-client probes and browser negatives run only on hosted CI.
Actual provider/scenario composition remains #8954's responsibility; these
synthetic boundary controls neither enable nor qualify a provider window.

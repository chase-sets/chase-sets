import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as edgeRequest } from "node:https";
import {
  createStagingPersonaSignIn,
  STAGING_PERSONA_MAGIC_LINK_SECRET_ENV,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import { readConnectorDrillDeployBinding } from "./connector-pairing-drill-deploy-binding.mjs";
import { runStagingDrillCommand } from "./connector-pairing-drill-staging-command.mjs";

vi.mock("node:https", () => ({ request: vi.fn() }));

// Entirely synthetic GitHub authority, including identities, commits, steps and deploy log.
const run = "90000000001";
const head = "a".repeat(40);
const jobId = "90000000002";
const now = "2026-11-14T20:00:00Z";
const runtimeStep = "Apply staging Kubernetes runtime secrets";
const repo = "repos/chase-sets/chase-sets";
const edgeBoundary = new Error("synthetic-edge-preflight-boundary");
const instant = (minute) => `2026-11-14T19:${minute}:00Z`;
const step = (name, number, start, end) => ({
  name,
  number,
  status: "completed",
  conclusion: "success",
  started_at: instant(start),
  completed_at: instant(end),
});
const syntheticJob = () => ({
  id: Number(jobId),
  run_id: Number(run),
  run_attempt: 1,
  name: "Deploy Staging",
  status: "completed",
  conclusion: "success",
  started_at: instant("00"),
  completed_at: instant("10"),
  steps: [
    step("Activate immutable release before staging mutation", 1, "01", "02"),
    step(runtimeStep, 2, "03", "04"),
    step("Deploy staging Kubernetes release", 3, "05", "08"),
    step("Mark staging applied", 4, "09", "09"),
  ],
});
const argv = (selectedRun = run) => [
  "--deploy-run",
  selectedRun,
  "--deploy-commit",
  head,
  "--platform-origin",
  "https://marketplace.staging.chasesets.com",
  "--client-id",
  "cc_client_synthetic",
  "--artifact-digest",
  "b".repeat(64),
  "--persona-alias",
  "synthetic-persona",
];

function syntheticGh({
  mutateJob = () => {},
  contained = true,
  missing = false,
  stale = false,
  malformed = false,
  manualCloseout = false,
  issueState = "CLOSED",
  linkedMerged = true,
  linked = true,
  incidentalOnly = false,
  incidentalContained = false,
} = {}) {
  const selectedJob = syntheticJob();
  if (stale) {
    selectedJob.started_at = "2026-11-01T19:00:00Z";
    selectedJob.completed_at = "2026-11-01T19:10:00Z";
    for (const step of selectedJob.steps) {
      step.started_at = step.started_at.replace("2026-11-14", "2026-11-01");
      step.completed_at = step.completed_at.replace("2026-11-14", "2026-11-01");
    }
  }
  const job = syntheticJob();
  mutateJob(job);
  const listedRun = {
    id: Number(run),
    name: "Platform Deploy",
    path: ".github/workflows/platform-production.yml",
    run_number: 1,
    run_attempt: 1,
    status: "completed",
    created_at: stale ? "2026-11-01T19:00:00Z" : instant("00"),
    updated_at: instant("10"),
  };
  const log = JSON.stringify(
    {
      schemaVersion: "platform-kubernetes-deployment/v1",
      action: "deploy",
      namespace: "chase-sets-platform",
      result: "success",
      image: `registry.synthetic.invalid/platform:${head}@sha256:${"d".repeat(64)}`,
    },
    null,
    2,
  )
    .split("\n")
    .map((line) => `${instant("07")} ${line}`)
    .join("\n");
  return vi.fn(async (args) => {
    const json = (value) => Buffer.from(JSON.stringify(value));
    if (args[0] === "graphql") {
      const issue = Number(args.find((arg) => arg.startsWith("number=")).split("=")[1]);
      return json({
        data: {
          repository: {
            issue: {
              state: issueState,
              closedByPullRequestsReferences: {
                nodes:
                  manualCloseout && issue === 10640
                    ? []
                    : [{ number: issue, merged: true, mergeCommit: { oid: "c".repeat(40) } }],
                pageInfo: { hasNextPage: false },
              },
              timelineItems: {
                nodes: linked
                  ? [
                      {
                        __typename: "CrossReferencedEvent",
                        source: {
                          __typename: "PullRequest",
                          number: 90000000003,
                          merged: linkedMerged,
                          mergeCommit: { oid: "e".repeat(40) },
                          baseRefName: "main",
                          repository: { nameWithOwner: "chase-sets/chase-sets" },
                        },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      });
    }
    const path = args.at(-1);
    if (path === `${repo}/pulls/10944`)
      return json(
        incidentalOnly || !linked
          ? null
          : {
              number: 10944,
              merged: linkedMerged,
              merge_commit_sha: "c".repeat(40),
              base: { ref: "main", repo: { full_name: "chase-sets/chase-sets" } },
            },
      );
    if (incidentalContained && path.includes(`/compare/${"e".repeat(40)}...`)) return json({ status: "ahead" });
    if (path.includes("/compare/")) return json({ status: contained ? "ahead" : "behind" });
    if (path.includes("/actions/workflows/")) return json({ total_count: 1, workflow_runs: [listedRun] });
    if (path === `${repo}/actions/runs/${run}/attempts/1/jobs?per_page=100&page=1`)
      return json({ total_count: 1, jobs: [selectedJob] });
    if (path === `${repo}/actions/jobs/${jobId}/logs`) return Buffer.from(log);
    if (path === `${repo}/actions/jobs/${jobId}`) {
      if (missing) throw new Error("synthetic-authority-missing");
      return malformed ? Buffer.from("not-json") : json(job);
    }
    throw new Error(`unexpected synthetic API path: ${path}`);
  });
}

let signIn;
let launch;
beforeEach(() => {
  signIn = vi.fn();
  launch = vi.fn();
  vi.mocked(edgeRequest)
    .mockReset()
    .mockImplementation(() => {
      throw edgeBoundary;
    });
});
afterEach(() => {
  expect(signIn).not.toHaveBeenCalled();
});
const invoke = (gh, args = argv()) => runStagingDrillCommand(args, { gh, now: () => now, signIn, launch });
const refused = (stop) => ({
  code: "connector-drill-deploy-binding-refused",
  evidence: expect.objectContaining({ deployStop: stop }),
});

describe("staging pairing command with its real deploy adapter and receipt-floor reader", () => {
  it("reaches the edge-preflight boundary with independently selected sign-in deploy authority", async () => {
    const gh = syntheticGh();
    await expect(invoke(gh)).rejects.toBe(edgeBoundary);
    expect(edgeRequest).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(edgeRequest.mock.calls[0][0].pathname).toBe("/channel-connector/oauth/authorize");
    expect(gh.mock.calls.map(([args]) => args.at(-1))).toContain(`${repo}/actions/jobs/${jobId}`);
  });

  it("passes the receipt-floor boundary for the mapped implementation alongside incidental references", async () => {
    await expect(invoke(syntheticGh({ manualCloseout: true }))).rejects.toBe(edgeBoundary);
    expect(edgeRequest).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { missing: true }],
    ["open prerequisite", { manualCloseout: true, issueState: "OPEN" }],
    ["unmerged mapped PR", { manualCloseout: true, linkedMerged: false }],
    ["uncontained mapped PR", { manualCloseout: true, contained: false }],
    ["missing mapped PR", { manualCloseout: true, linked: false }],
    ["incidental reference alone", { manualCloseout: true, incidentalOnly: true }],
    [
      "uncontained implementation beside contained incidental reference",
      { manualCloseout: true, contained: false, incidentalContained: true },
    ],
    ["malformed JSON", { malformed: true }],
    [
      "wrong job identity",
      {
        mutateJob: (job) => {
          job.id++;
        },
      },
    ],
    [
      "wrong run identity",
      {
        mutateJob: (job) => {
          job.run_id++;
        },
      },
    ],
    [
      "wrong attempt",
      {
        mutateJob: (job) => {
          job.run_attempt++;
        },
      },
    ],
    [
      "wrong job name",
      {
        mutateJob: (job) => {
          job.name = "Synthetic other job";
        },
      },
    ],
    [
      "unfinished job",
      {
        mutateJob: (job) => {
          job.status = "in_progress";
        },
      },
    ],
    [
      "failed job",
      {
        mutateJob: (job) => {
          job.conclusion = "failure";
        },
      },
    ],
    [
      "stale job observation",
      {
        mutateJob: (job) => {
          job.completed_at = "2026-11-01T19:10:00Z";
        },
      },
    ],
    [
      "missing steps",
      {
        mutateJob: (job) => {
          job.steps = [];
        },
      },
    ],
    [
      "missing runtime apply",
      {
        mutateJob: (job) => {
          job.steps.splice(1, 1);
        },
      },
    ],
    [
      "duplicate runtime apply",
      {
        mutateJob: (job) => {
          job.steps.push({ ...job.steps[1] });
        },
      },
    ],
    [
      "skipped runtime apply",
      {
        mutateJob: (job) => {
          job.steps[1].conclusion = "skipped";
        },
      },
    ],
    [
      "failed runtime apply",
      {
        mutateJob: (job) => {
          job.steps[1].conclusion = "failure";
        },
      },
    ],
    [
      "unfinished runtime apply",
      {
        mutateJob: (job) => {
          job.steps[1].status = "in_progress";
        },
      },
    ],
    [
      "malformed runtime timestamp",
      {
        mutateJob: (job) => {
          job.steps[1].completed_at = null;
        },
      },
    ],
    [
      "runtime apply after deploy",
      {
        mutateJob: (job) => {
          job.steps[1].completed_at = instant("09");
        },
      },
    ],
    [
      "runtime apply before activation",
      {
        mutateJob: (job) => {
          job.steps[1].started_at = instant("00");
        },
      },
    ],
    [
      "runtime apply outside job",
      {
        mutateJob: (job) => {
          job.started_at = instant("04");
        },
      },
    ],
    [
      "runtime step out of order",
      {
        mutateJob: (job) => {
          job.steps[1].number = 4;
        },
      },
    ],
    ["sign-in merge not contained", { contained: false }],
  ])("refuses %s floor authority before edge, browser or sign-in", async (_name, options) => {
    await expect(invoke(syntheticGh(options))).rejects.toMatchObject(refused("receipt-floor-unavailable"));
    expect(edgeRequest).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses stale or superseded deploy authority before edge, browser or sign-in", async () => {
    await expect(invoke(syntheticGh({ stale: true }))).rejects.toMatchObject(refused("deploy-too-stale"));
    await expect(invoke(syntheticGh(), argv("90000000000"))).rejects.toMatchObject(refused("deploy-run-not-newest"));
    expect(edgeRequest).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a receipt floor newer than the selected deploy", async () => {
    const result = await readConnectorDrillDeployBinding(
      {
        run,
        commit: head,
        requiredIssues: [10640],
        requireReceiptFloor: true,
      },
      { gh: syntheticGh(), now: () => now, readReceiptFloor: async () => "90000000003" },
    );
    expect(result).toEqual({ stop: "receipt-floor-newer-than-deploy" });
    expect(edgeRequest).not.toHaveBeenCalled();
  });

  it("does not read the receipt floor in smoke mode", async () => {
    const gh = syntheticGh({ missing: true });
    // Stop before Chromium; smoke has no edge preflight and needs no sign-in floor.
    launch.mockRejectedValue(edgeBoundary);
    await expect(invoke(gh, ["--smoke", ...argv().slice(0, 6)])).rejects.toBe(edgeBoundary);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(edgeRequest).not.toHaveBeenCalled();
    expect(gh.mock.calls.map(([args]) => args.at(-1))).not.toContain(`${repo}/actions/jobs/${jobId}`);
  });

  it("keeps the staging bearer out of deploy reads and the environment", async () => {
    const previous = process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV];
    const bearer = "synthetic-staging-secret-marker";
    try {
      process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
      const capturedSignIn = createStagingPersonaSignIn();
      expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
      const gh = syntheticGh();
      await expect(runStagingDrillCommand(argv(), { gh, now: () => now, signIn: capturedSignIn, launch })).rejects.toBe(
        edgeBoundary,
      );
      expect(JSON.stringify(gh.mock.calls)).not.toContain(bearer);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV];
      else process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = previous;
    }
  });
});

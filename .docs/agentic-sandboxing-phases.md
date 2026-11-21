# Agentic sandboxing and guardrail phases

## Purpose

This document defines a phased approach for restricting agent access to task
state, Git operations, worktrees, credentials, and merge/release boundaries.

The objective is to prevent accidental or unauthorized agent mutations while
preserving a practical development loop. The design must distinguish:

- convenience controls that guide an agent;
- local enforcement that blocks ordinary violations; and
- authoritative enforcement that remains effective when local hooks or wrappers
  are bypassed.

## Security premise

Git does not provide a per-agent capability system. If an agent runs as the same
Unix user and can execute arbitrary commands, it can usually:

- invoke the real Git binary directly;
- edit `.git` administrative files;
- remove or replace local hooks;
- use `git -c core.hooksPath=...`;
- bypass hooks with `--no-verify`;
- modify task files directly; or
- change `PATH` and bypass command wrappers.

Therefore:

- local hooks are workflow enforcement, not complete security;
- file permissions help only when ownership boundaries are real;
- a wrapper earlier in `PATH` is convenience protection, not authority; and
- CI, protected branches, server-side hooks, or a separate controller are needed
  for authoritative enforcement.

## Protection objectives

The sandboxing process should protect:

1. task and work-item records from unauthorized direct writes;
2. receipt records from agent rewriting;
3. the primary branch from direct agent pushes or incomplete merges;
4. release tags from context-branch creation or mutation;
5. credentials and secret paths from agent reads;
6. unrelated repository paths from task-scoped changes; and
7. the integrity of the source commit associated with task evidence.

## Phase 1 — Establish branch and worktree boundaries

### Goal

Ensure planning, task processing, merge, and release operations occur in the
correct branch and worktree before stronger isolation is introduced.

### Mechanisms

- plan on `main` or `master`;
- start a work item explicitly from the merge target;
- process tasks only on the declared context branch;
- use a dedicated context worktree when multiple agents or work items are active;
- reject dirty worktrees before starting a work item;
- reject detached HEAD and unrelated branches; and
- forbid release tags on context branches.

Existing mechanisms include `sdlc work-item start`, branch validation,
pre-commit task-branch checks, and pre-push primary-branch release checks.

### Recommended future work item

**Title:** Standardize isolated work-item branch and worktree startup

**Scope:** Add worktree-aware start/readiness reports, branch/worktree identity
records, dirty-tree checks, and tests for competing worktrees.

**Non-goals:** Do not claim protection from an agent with unrestricted filesystem
access. Do not add task receipts or server-side enforcement yet.

## Phase 2 — Add deterministic task linearization and leases

### Goal

Prevent competing agents from selecting or modifying the same task and establish
a stable task order for execution.

### Mechanisms

Add:

```bash
sdlc task linearize --work-item <id> --json
sdlc task lease --task <uid> --json
sdlc task release --task <uid> --json
```

A lease should bind task UID, work-item ID, agent/session ID, branch/worktree
identity, linearization digest, source HEAD, creation time, and expiration or
explicit release. `task next` should scan linearized order and select the first
task that is unprocessed, unleased, and task-ready.

### Recommended future work item

**Title:** Add deterministic task ordering and exclusive task leases

**Scope:** Implement graph linearization, task leases, conflict detection, lease
expiration, and task-next integration.

**Non-goals:** Do not protect files from a privileged agent. Do not execute tasks
automatically. Do not implement full requirement/evidence completeness yet.

## Phase 3 — Route task state through controlled SDLC mutations

### Goal

Prevent agents from directly editing task records when lifecycle invariants must
be preserved.

### Mechanisms

Expose controlled commands such as:

```bash
sdlc task start --task <uid> --json
sdlc task record --task <uid> --result-file <path> --json
sdlc task block --task <uid> --reason <text> --json
sdlc task complete --task <uid> --json
sdlc work-item complete --work-item <id> --json
```

Each mutation should verify readiness and lease ownership, validate the requested
transition and new result, write atomically, calculate old/new record digests,
capture changed paths/source/graph/evidence digests, write a receipt, and create
or prepare the controlled commit.

### Recommended future work item

**Title:** Route task and work-item state changes through receipt-backed mutations

**Scope:** Add controlled mutation commands, atomic task writes, receipt schema,
readiness enforcement, transition validation, source/graph digests, and mutation
tests.

**Non-goals:** Do not claim local hooks are tamper-proof. Do not mutate source
implementation through the task-state API. Do not add hosted merge enforcement yet.

## Phase 4 — Communicate receipts through commits and merge manifests

### Goal

Make task mutations auditable and bind them to the source commit and graph state
that produced them.

### Receipt record

Persist receipts under a controlled path such as:

```text
.sdlc/receipts/tasks/<task-uid>/<receipt-id>.json
```

The receipt should include work-item ID, task UID, operation, old/new record
digests, source commit, changed paths, task-owned path decision, linearization
digest, dependency result digests, validation report digest, actor/session, and
timestamp.

### Commit communication

The controlled task commit should include trailers:

```text
SDLC-Work-Item: WI-0034
SDLC-Task: WI-0034-10000000
SDLC-Operation: record-result
SDLC-Receipt: .sdlc/receipts/tasks/WI-0034-10000000/<receipt-id>.json
SDLC-Receipt-SHA256: sha256:...
SDLC-Linearization-SHA256: sha256:...
SDLC-Source-Commit: <sha>
```

Trailers are discoverability metadata only. Merge validation must independently
hash the receipt and compare it with the task mutation, commit, and current graph.

### Merge manifest

Before merge, a controller should generate:

```bash
sdlc work-item merge-check \
  --work-item WI-0034 \
  --source-branch WI-0034-task-lifecycle-status \
  --target-branch main \
  --json
```

The merge manifest should include source/target branches, merge base, source
HEAD, changed paths, task receipts, completeness and linearization digests,
review/validation/delivery result digests, expected release impact, and proposed
SDLC commands with executable identity, argument vector, and expected exit code.

The merge controller must recompute the commands and must not trust agent-provided
stdout alone.

### Recommended future work item

**Title:** Bind task receipts and proposed SDLC commands to merge manifests

**Scope:** Add receipt schema, commit trailer generation, merge manifests, receipt
hash verification, structured proposed-command records, and merge-check tests.

**Non-goals:** Do not make commit trailers authoritative without receipt
verification. Do not add server-side branch protection yet. Do not infer task
correctness from command exit codes alone.

## Phase 5 — Separate agent and task-controller access

### Goal

Prevent ordinary agents from writing task records and receipts directly.

### Preferred architecture

Use two logical worktrees or execution domains.

#### Agent implementation worktree

Writable paths are limited to `src/`, `tests/`, package files, and declared
implementation paths. The agent should not be able to write:

```text
.docs/work-items/
.sdlc/receipts/
.git/
```

#### Task-controller worktree or service

Only the controller writes `.docs/work-items/` and `.sdlc/receipts/`. The
controller performs readiness, task mutation, receipt creation, task commits,
completeness checks, and merge preparation.

The agent submits a result file or structured request:

```bash
sdlc task record \
  --task WI-0034-10000000 \
  --result-file /agent-output/result.json \
  --source-commit <sha> \
  --json
```

This boundary is authoritative only when the agent cannot run as the controller’s
Unix user, change ACLs, access the controller worktree, modify `.git`, replace
the controller executable, or bypass the controller through another path.

### Recommended future work item

**Title:** Isolate agent implementation worktrees from task-state control

**Scope:** Define agent/controller worktrees, Unix ownership and ACL boundaries,
controlled result submission, secret exclusion, task-state read policy, and
integration fixtures.

**Non-goals:** Do not treat a same-user worktree split as a security boundary.
Do not claim protection against root or unrestricted host access. Do not add
remote deployment isolation.

## Phase 6 — Add local hook defense in depth

### Goal

Provide fast local feedback while clearly limiting the trust placed in hooks.

### Mechanisms

Pre-commit should reject task mutations without valid receipts, lifecycle
transitions without controlled mutation records, task processing on the wrong
branch, paths outside task ownership, stale graph digests, and direct complete
status edits without completion evidence.

Pre-merge checks should validate the merge base and source branch where the Git
workflow invokes the hook. Hooks should emit stable machine-readable errors and
must not silently rewrite task or source files.

### Recommended future work item

**Title:** Add local hook checks for receipt-backed task mutations

**Scope:** Extend the dispatcher and installer with pre-commit/pre-merge checks,
receipt verification, ownership checks, stale-graph detection, and focused hook
tests.

**Non-goals:** Do not present local hooks as bypass-proof security. Do not mutate
the index or worktree automatically.

## Phase 7 — Add CI and protected-branch authority

### Goal

Make merge protection authoritative even when an agent bypasses local hooks.

### Mechanisms

Require a protected-branch check that independently runs:

```bash
sdlc work-item validate --work-item <id> --json
sdlc work-item readiness --work-item <id> --json
sdlc work-item completeness --work-item <id> --json
sdlc work-item merge-check --work-item <id> --json
```

The check should reject unreceipted mutations, stale/mismatched receipts,
missing review/validation gates, incomplete dependencies, ownership violations,
and direct complete-status edits without eligibility evidence. Equivalent checks
can run in server-side `pre-receive`/`update` hooks or as required hosted checks.

### Recommended future work item

**Title:** Enforce receipt and completeness gates on protected branch merges

**Scope:** Add CI/server-side merge validation, protected-branch configuration,
merge-check reports, source/receipt verification, and bypass/audit tests.

**Non-goals:** Do not rely on local hooks as the only authority. Do not make
administrative bypasses invisible. Do not implement deployment approval here.

## Phase 8 — Integrate completion and release controls

### Goal

Ensure only current, complete, receipt-backed work can be merged and released.

### Mechanisms

Add:

```bash
sdlc work-item completion-check --work-item <id> --json
sdlc work-item complete --work-item <id> --json
sdlc release audit --work-item <id> --json
```

Completion eligibility should require work-item dependencies, terminal and
eligible tasks, closed implementation/review/validation gates, current evidence,
no blocking findings, a current completeness report, valid branch/merge state,
and a valid merge manifest.

Release audit should additionally require primary-branch merge, expected version
impact, package version consistency, an annotated tag at the primary tip, and
release report/receipt digests.

### Recommended future work item

**Title:** Gate work-item completion and release on current receipts and merge audits

**Scope:** Add derived status, controlled completion, merge-manifest verification,
release audit, primary-branch tag checks, and end-to-end completion/release tests.

**Non-goals:** Do not automatically mark work items complete. Do not create tags
on context branches. Do not infer production readiness or business success.

## Recommended order

1. branch and worktree boundaries;
2. deterministic task linearization and leases;
3. controlled task/work-item mutations;
4. receipt and merge-manifest communication;
5. agent/controller worktree isolation;
6. local hook defense in depth;
7. CI/protected-branch authority; and
8. derived completion and release eligibility.

## Security limitations

If an agent has unrestricted access to the same Unix user, filesystem, Git
administrative directory, and process execution environment, no repository-local
mechanism can reliably prevent deliberate bypass. Effective containment requires
separate users, ACLs, containers, a controller process, protected branches, or
server-side merge enforcement.

No single mechanism is sufficient. The intended design is defense in depth:
readiness and leases prevent ordinary conflicts, controlled mutation preserves
invariants, receipts establish provenance, worktree/process isolation limits
direct writes, and protected CI/server-side checks remain authoritative.
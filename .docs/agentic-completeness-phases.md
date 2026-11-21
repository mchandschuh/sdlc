# Agentic completeness improvement phases

## Purpose

This document defines a phased approach for making SDLC work execution
deterministic, auditable, and resistant to incomplete agent output.

The objective is not to claim that static validation proves implementation
correctness, provider behavior, deployment safety, or production readiness. The
objective is to ensure that every work-item claim has:

- a declared requirement or objective;
- a traceable acceptance condition;
- an executable or inspectable test case;
- an owning implementation, review, validation, or delivery task;
- current evidence;
- an explicit limitation; and
- a deterministic gate before completion.

This is a process-design document. It does not create work items or task
hierarchies. Each phase includes guidance for designing a later, bounded work
item.

## Distinct facts and gates

| Fact | Meaning |
| --- | --- |
| Structural validity | Documents satisfy their selected JSON Schema contracts. |
| Reference integrity | References have supported syntax and resolve to current targets. |
| Work-item readiness | The work item may safely be started. |
| Task readiness | The specific task may safely be started. |
| Execution | A task or procedure was actually processed. |
| Evidence completeness | Required outputs, executions, and evidence are present. |
| Review/validation closure | Independent review and validation gates passed. |
| Completion eligibility | Current evidence permits the requested lifecycle transition. |
| Completion | An explicit lifecycle transition was authorized and recorded. |

`processingStatus`, task lifecycle `status`, result `status`, review decision,
validation outcome, and work-item status are independent values. One must not be
inferred from another.

For example:

- `processing_completed` does not mean that a task passed;
- a result with `status: passed` does not prove independent review;
- a task with `status: complete` does not prove that the work item is complete;
- `work-item validate` passing does not prove implementation or provider
  execution.

## Readiness semantics

### Work-item readiness

Proposed command:

```bash
sdlc work-item readiness --work-item WI-0034 --json
```

This answers:

> Can this work item safely be started?

Checks should include:

- valid `work-item.json` schema and unique requirements/acceptance criteria;
- explicit work-item dependencies and dependency statuses;
- materialized required planning documents and task records;
- valid task identifiers, parentage, and dependency references;
- no dependency cycle;
- an available `main` or `master` merge target;
- a valid context branch declaration;
- current branch is the merge target;
- a clean worktree and no conflicting context branch; and
- no unresolved required planning reference.

Work-item readiness does not mean implementation is complete. It means that
beginning the work item is safe and its work-item dependencies are met.

### Task readiness

Proposed command:

```bash
sdlc task readiness --task WI-0034-10000000 --json
```

This answers:

> Can this specific task safely be started now?

Checks should include:

- parent work item is ready or active;
- task is structurally valid and still unprocessed;
- task dependencies exist and are eligible;
- required upstream results and digests resolve;
- required inputs, policies, and design documents resolve;
- current branch is the declared task-processing branch;
- task-owned paths are available; and
- no conflicting task lease or active task exists.

Task readiness is narrower than work-item readiness. A ready work item may have
no ready task if its first task is blocked.

## Deterministic task linearization

Proposed command:

```bash
sdlc task linearize --work-item WI-0034 --json
```

The report should use a versioned contract such as:

```json
{
  "schema": "https://schemas.handschuh.dev/sdlc/task-linearization/v1",
  "workItemId": "WI-0034",
  "algorithm": "topological-order-v1",
  "graphSha256": "sha256:...",
  "items": [{ "rank": 1, "taskUid": "WI-0034-10000000", "dependencies": [] }]
}
```

The algorithm should load every task, validate unique IDs and order keys, add
`dependsOn` and required `parentTaskUid` edges, reject missing targets and
cycles, and perform a deterministic topological sort. `orderKey`, then
`taskUid`, should be stable tie-breakers. The graph digest must cover task
identities, edges, relevant lifecycle state, and the algorithm version.

`task next` should generate or verify the current linearization, scan tasks in
linearized order, evaluate task readiness, and select the first unprocessed and
ready task. It need not explain every skipped task. If no task is ready, it
should return a stable `none-ready` result with aggregate blocking findings.

## Phase 1 — Lifecycle and transition invariants

### Goal

Define explicit, type-specific lifecycle states and keep them distinct from
envelope processing and result outcome states.

### Deterministic mechanisms

- require task-specific lifecycle status contracts;
- define allowed statuses by task type;
- define valid transitions;
- define status-dependent result requirements;
- distinguish transitional, milestone, terminal, blocked, deferred, and
  superseded states;
- reject invalid status/result combinations; and
- require full result contracts for terminal statuses.

The existing WI-0034 design is intended to address this phase. Before executing
WI-0034, review its task records for semantic carryover from WI-0033 and correct
any task objectives that do not match the WI-0034 request.

### Recommended future work item

**Title:** Enforce type-specific task lifecycle status contracts

**Scope:** Add task-type lifecycle metadata, status-dependent result validation,
transition rules, persisted-record migration, schema documentation, and
representative lifecycle matrix tests.

**Non-goals:** Do not add readiness selection, full traceability analysis,
server-side Git enforcement, or production-readiness claims.

## Phase 2 — Deterministic task linearization

### Goal

Replace linear-directory assumptions with a deterministic dependency-aware task
order while preserving reproducible selection.

### Deterministic mechanisms

- add `sdlc task linearize`;
- build a graph from `dependsOn` and `parentTaskUid`;
- detect missing nodes and cycles;
- produce stable topological order;
- include graph and linearization digests; and
- make `task next` consume the linearization.

### Recommended future work item

**Title:** Add deterministic dependency-aware task linearization

**Scope:** Implement graph construction, validation, cycle detection, stable
topological ordering, a versioned linearization report, graph digests, and
linearization-aware `task next` tests.

**Non-goals:** Do not decide task readiness, execute tasks, mutate task records,
or infer dependencies from prose.

## Phase 3 — Work-item and task readiness

### Goal

Make safe-start decisions deterministic.

### Deterministic mechanisms

Add:

```bash
sdlc work-item readiness --work-item <id> --json
sdlc task readiness --task <uid> --json
```

Use stable report schemas and finding codes. Include current branch, graph
digest, dependency digests, readiness decision, and blocking findings. Integrate
task readiness into `task next`.

### Recommended future work item

**Title:** Add safe-start readiness gates for work items and tasks

**Scope:** Add work-item dependency representation, work-item readiness, task
readiness, readiness reports, task-next integration, and readiness fixtures.

**Non-goals:** Do not claim implementation correctness, completion, or provider
behavior. Do not execute commands automatically. Do not require per-skipped-task
explanations.

## Phase 4 — Controlled task and work-item mutation

### Goal

Prevent agents from bypassing lifecycle invariants by editing task or work-item
records directly.

### Deterministic mechanisms

Add controlled commands such as:

```bash
sdlc task start --task <uid> --json
sdlc task record --task <uid> --result-file <path> --json
sdlc task block --task <uid> --reason <text> --json
sdlc task complete --task <uid> --json
sdlc work-item complete --work-item <id> --json
```

Each mutation should validate current state and readiness, validate the requested
transition and new result, write atomically, calculate old/new record digests,
capture changed paths/source/graph/evidence digests, write a receipt, and create
or prepare the controlled commit.

### Recommended future work item

**Title:** Route task and work-item state changes through receipt-backed mutations

**Scope:** Add controlled mutation commands, atomic task writes, receipt schema,
readiness enforcement, transition validation, source/graph digests, and mutation
tests.

**Non-goals:** Do not claim local hooks are tamper-proof. Do not use file
permissions as the only security control. Do not mutate source implementation
through the task-state API.

## Phase 5 — Requirement-to-evidence traceability

### Goal

Prove that planning elements are connected before execution begins.

### Deterministic mechanisms

Add:

```bash
sdlc work-item traceability --work-item <id> --json
sdlc work-item completeness --work-item <id> --json
```

Evaluate:

```text
requirements -> acceptance criteria -> objectives -> test cases
  -> implementation/validation ownership -> evidence
```

Report uncovered requirements, acceptance criteria, objectives, and test cases;
orphan tasks; unused cases; duplicate ownership; and references to unrelated
work items. Distinguish `defined`, `owned`, `implemented`, `executed`, `passed`,
`failed`, `blocked`, and `waived`.

### Recommended future work item

**Title:** Add deterministic work-item traceability and coverage evaluation

**Scope:** Add a versioned completeness report schema, build the requirement and
test graph, detect missing/ambiguous edges, report orphan elements, and produce
JSON/Markdown traceability reports.

**Non-goals:** Do not infer semantic equivalence with an LLM. Do not claim that a
defined test was executed. Do not change lifecycle transitions.

## Phase 6 — Execution, review, validation, and freshness closure

### Goal

Prove that declared work actually happened and that its evidence is current.

### Deterministic mechanisms

Implementation tasks should require:

- result status compatible with task status;
- every declared change to have paths;
- paths to remain inside `ownedPaths`;
- required test implementations;
- verification executions;
- passing required executions; and
- current source and artifact digests.

Validation tasks should require:

- every required procedure to have an execution;
- every execution to reference a declared procedure;
- every execution to record an observed outcome and evidence;
- expected and observed outcomes to be compared; and
- failed/blocked required procedures to prevent a passed result.

Review tasks should require:

- every criterion to have an evaluation;
- required evidence to exist;
- a current target result digest;
- an independent reviewer; and
- policy-compatible decisions and findings.

### Recommended future work item

**Title:** Enforce execution and current-evidence closure for task gates

**Scope:** Add semantic validators for implementation, review, validation, and
delivery payloads; require procedure/execution closure; enforce evidence and
freshness rules; and reject passed/complete states with missing evidence.

**Non-goals:** Do not authorize production deployment or infer provider
correctness. Do not allow result prose to substitute for execution receipts.

## Phase 7 — Protected task tree and merge gates

### Goal

Make task-record protection authoritative at merge boundaries rather than relying
only on local hooks.

### Deterministic mechanisms

Use defense in depth:

- an agent implementation worktree for source and tests;
- a controller-owned task-state worktree or controlled mutation process;
- local pre-commit checks for fast feedback;
- required CI checks for pull requests;
- a protected primary branch; and
- server-side or hosting-provider merge checks where available.

Merge checks should reject:

- task-file changes without valid mutation receipts;
- receipts with mismatched hashes;
- missing task commit trailers;
- task mutations outside declared ownership;
- stale linearization digests;
- invalid lifecycle transitions; and
- incomplete readiness/completeness gates.

### Recommended future work item

**Title:** Reject unauthorized task mutations at merge and protected-branch boundaries

**Scope:** Add receipt verification, merge manifests, required commit trailers,
protected-branch CI checks, changed-path ownership checks, and server-independent
merge audit commands.

**Non-goals:** Do not treat local read-only files or hooks as authoritative
security. Do not allow merge checks to trust commit trailers without verifying the
referenced receipt.

## Phase 8 — Derived completion and release eligibility

### Goal

Prevent a work item from being marked complete unless current evidence satisfies
every required gate.

### Deterministic mechanisms

Add:

```bash
sdlc work-item completion-check --work-item <id> --json
sdlc work-item complete --work-item <id> --json
sdlc release audit --work-item <id> --json
```

Completion eligibility should require work-item dependency closure, terminal and
eligible required tasks, closed implementation/review/validation gates, current
evidence/digests, no blocking findings, valid branch/merge state, and a current
completeness report.

The controlled `complete` command should record the completion report digest and
commit the lifecycle transition. Direct edits to `status: complete` should be
rejected or reported as ineligible.

### Recommended future work item

**Title:** Derive work-item completion and release eligibility from current evidence

**Scope:** Add completion reports, derived status, completion eligibility, a
controlled completion transition, pre-commit enforcement, and release audits.

**Non-goals:** Do not automatically mark work items complete. Do not infer
production readiness. Do not create tags on context branches. Do not rewrite
package versions silently.

## Recommended order

The phases are ordered so each creates prerequisites for the next:

1. lifecycle and transition invariants;
2. deterministic task linearization;
3. work-item and task readiness;
4. controlled mutation with receipts;
5. requirement-to-evidence traceability;
6. execution, review, validation, and freshness closure;
7. protected task tree and merge gates; and
8. derived completion and release eligibility.

## Evidence limitations

Even after all phases are implemented, deterministic controls can prove only that
records exist, references resolve, required procedures executed, evidence is
current and connected, lifecycle gates passed, and release policy was satisfied.

They cannot by themselves prove implementation correctness, external provider
behavior, production readiness, business success, or security against an agent
with unrestricted host privileges. Those claims require separate evidence tiers
and explicit non-claims.

# WI-0038 Phase 2 dependency graph and selection contract

## Purpose

This document is the authoritative design boundary for Phase 2 of the agentic
completeness improvement plan. It defines structural dependency graph behavior,
deterministic graph linearization, initial task selection, initial work-item
selection, CLI response naming, and the Phase 3 follow-up boundary.

Phase 2 is read-only structural and selection behavior. It does not implement
readiness, leases, mutation, receipts, work-item dependencies, evidence closure,
completion eligibility, or production readiness.

## Dependency source

The only dependency source is explicit `dependsOn` data on task envelopes.

The following must never imply a dependency:

- `parentTaskUid`;
- `orderKey`;
- task UID;
- task type;
- filename;
- directory order; or
- task prose.

Every task must explicitly declare what it depends on before it can be considered
for dependency-aware selection.

`parentTaskUid` is a structural-container field in the existing task format. Phase
2 must not use it for graph edges, dependency satisfaction, ordering, cycle
detection, diagnostics, projections, or selection. A later work item will remove
that field from the task contract.

## Graph nodes

Graph nodes represent complete task records and may include observed execution
state, including:

- task UID;
- order key;
- task type;
- explicit dependency references;
- repository-relative path;
- envelope `processingStatus`; and
- task lifecycle `status`.

Execution state may be carried on nodes for later inspection, but graph
construction must not consult it. Changing processing or lifecycle state must not
change the structural graph or full-graph linearization.

## Graph construction

The graph builder must:

1. Load every task record in the selected work item.
2. Create one node per task UID.
3. Validate unique task UIDs.
4. Validate unique order keys.
5. Read only explicit `dependsOn` references.
6. Create dependency-to-dependent edges.
7. Reject missing dependency targets.
8. Reject self-dependencies.
9. Detect dependency cycles.
10. Return no usable graph or partial linearization when blocking findings exist.

Order keys are deterministic ordering metadata only. Duplicate order keys are a
blocking structural error and must be rejected by `sdlc work-item validate`, which
also allows the existing pre-commit validation path to reject commits containing
them.

Recommended structural finding codes:

```text
DUPLICATE_TASK_UID
DUPLICATE_ORDER_KEY
MISSING_DEPENDENCY
SELF_DEPENDENCY
DEPENDENCY_CYCLE
```

## Full-graph linearization

A valid graph is topologically sorted using:

1. dependency edges as the ordering constraint;
2. `orderKey` as the first tie-breaker; and
3. `taskUid` as the second tie-breaker.

The full linearization includes every graph node exactly once and places each
dependency before every dependent. The output remains stable when execution state
changes because execution state is not a graph-construction input.

No graph SHA-256 or linearization SHA-256 values are required in Phase 2.

## Cycle diagnostics

Cycle detection uses explicit `dependsOn` edges only. A cyclic graph fails closed:

- no partial linearization is returned;
- `task next` does not fall back to directory order;
- human output reports stable structural findings; and
- JSON output reports deterministic finding codes and cycle witnesses.

The implementation should report one deterministic cycle witness per strongly
connected component rather than enumerating every possible elementary cycle. Cycle
adjacency and findings should be sorted by `orderKey`, then `taskUid`, and each
witness should be rotated to a canonical starting node.

Example:

```json
{
  "code": "DEPENDENCY_CYCLE",
  "severity": "blocking",
  "taskUids": [
    "WI-0038-20000000",
    "WI-0038-30000000",
    "WI-0038-20000000"
  ],
  "message": "Explicit task dependencies form a cycle."
}
```

## Dependency satisfaction for task next

Task selection consumes the graph and full linearization but does not mutate them.

The initial dependency-satisfaction rule is intentionally strict:

> An explicit task dependency is met only when the referenced dependency task has
> task lifecycle `status: complete`.

The following do not satisfy a dependency by themselves:

- envelope `processingStatus: processing_completed`;
- result `status: passed`;
- task lifecycle milestone status;
- review decision;
- validation outcome; or
- work-item status.

The initial `task next` selection algorithm is:

1. Build and validate the complete dependency graph.
2. Produce the full deterministic linearization.
3. Scan tasks in linearized order.
4. Skip tasks whose task lifecycle status is `complete`.
5. Skip tasks with any explicit dependency whose task lifecycle status is not
   `complete`.
6. Select the first remaining task.
7. Return a stable `none` result if no task remains.

An active or partially completed task remains the selected next task until its own
task lifecycle reaches `complete`. A downstream task cannot be selected while any
explicit dependency remains active, blocked, deferred, planned, at a milestone,
or otherwise non-terminal.

This is dependency satisfaction, not full task readiness. Phase 3 must add the
broader readiness decision.

## Initial work-item next behavior

Add:

```bash
sdlc work-item next --json
```

The initial command must:

- enumerate work items deterministically;
- select the first work item whose status is not `complete`;
- return a stable `none` result when all discovered work items are complete;
- remain read-only; and
- avoid inferring readiness, branch state, evidence, work-item dependencies, or
  release eligibility.

This initial behavior is deliberately provisional and must be revisited in Phase
3 after explicit work-item dependency representation is designed.

## CLI response schemas

CLI response objects use the `cli-*` schema family and must not be confused with
task-type contracts.

Required response schema families:

```text
https://schemas.handschuh.dev/sdlc/cli-dependency-linearization/v1
https://schemas.handschuh.dev/sdlc/cli-task-next/v1
https://schemas.handschuh.dev/sdlc/cli-work-item-next/v1
```

The corresponding repository paths are:

```text
schemas/sdlc-cli-dependency-linearization/v1/
schemas/sdlc-cli-task-next/v1/
schemas/sdlc-cli-work-item-next/v1/
```

The existing `schemas/sdlc-task-next/v1/` response contract is a legacy naming
boundary and must not be extended as the long-term CLI response convention.

## Schema skill

The repository must contain:

```text
.cline/skills/schemas/SKILL.md
```

It must document JSON Schema 2020-12, versioned high-level-object paths, stable
`$id` values, closed response contracts, schema audit inclusion, representative
instance validation, task-type naming, CLI response naming, and version migration
rules.

## Phase 3 follow-up

The completeness documentation must explicitly require Phase 3 to revisit both
selection commands.

### Task next follow-up

Phase 3 must extend `task next` to account for:

- full task readiness;
- required inputs and upstream results;
- branch and context state;
- task-owned paths;
- dependency-state explanations;
- blocked and deferred dependencies; and
- readiness reports and stable finding codes.

### Work-item next follow-up

Phase 3 must extend `work-item next` to account for:

- explicit work-item dependency representation;
- work-item dependency graph construction and projections;
- work-item readiness;
- branch and context state;
- blocked and deferred work items;
- completion eligibility; and
- release eligibility.

The initial Phase 2 selectors must not be treated as the final readiness model.

## Non-claims

Phase 2 graph validation and selection prove only that explicit dependency
structure can be parsed, validated, linearized, and inspected for the initial
terminal-completion rule. They do not prove task readiness, execution correctness,
evidence freshness, provider behavior, deployment safety, completion eligibility,
or production readiness.
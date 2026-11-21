# WI-0037 Phase 1 lifecycle and transition contract

## Purpose

This document is the authoritative design boundary for Phase 1 of the agentic
completeness improvement plan. It defines the task lifecycle contract that later
readiness, controlled-mutation, evidence, merge, and completion phases consume.

Phase 1 validates lifecycle structure and status-aware result shape. It does not
prove implementation correctness, execution, provider behavior, deployment safety,
production readiness, requirement coverage, or evidence freshness.

## Independent facts

The following values are independent and must never be derived from one another:

- envelope `processingStatus`;
- task-specific lifecycle `task.status`;
- task-specific observed `result.status`;
- review decision;
- validation outcome; and
- parent work-item status.

Examples:

- `processing_completed` does not mean the task passed;
- a result with `status: passed` does not establish independent review;
- a task with `status: complete` does not complete its work item; and
- `work-item validate` passing does not prove implementation or provider execution.

## Common lifecycle policy

Every task type uses `planned` as its only initial status. The shared transition
rules are:

```text
planned  -> active | blocked | deferred
active   -> task-specific milestone(s) | blocked | deferred
blocked  -> active
deferred -> planned | active | blocked
milestone -> task-specific next milestone(s) | complete | blocked | deferred
complete -> no normal outgoing transitions
```

Additional rules:

- Non-`superseded` milestones are forward-only and do not return directly to
  `active`.
- A milestone may move to `blocked` or `deferred` and later resume through the
  common transitions.
- `superseded`, where supported, is a non-terminal milestone entered only from a
  task-specific milestone.
- `superseded` may resume to `planned`, `active`, or `blocked`.
- `deferred -> planned` and `superseded -> planned` clear result fields because
  `planned` forbids them.
- `active -> blocked` and `active -> deferred` may retain partial result fields.
- `planned -> blocked` and `planned -> deferred` may not introduce result fields.
- `complete` has no normal outgoing transition. Recovery requires a new rework
  task or work item rather than reopening the completed task.
- Direct human or agent edits to task or work-item status are not valid lifecycle
  operations. Later phases must require the SDLC CLI and progressively reject
  direct file mutations.

## Task-specific lifecycle paths

| Task type | Transitional statuses | Milestones | Terminal | Primary forward path |
| --- | --- | --- | --- | --- |
| decomposition | planned, active, blocked, deferred | decomposed | complete | active -> decomposed -> complete |
| research | planned, active, blocked, deferred | researched | complete | active -> researched -> complete |
| decision | planned, active, blocked, deferred | awaiting-approval, decided, superseded | complete | active -> awaiting-approval -> decided -> complete |
| design | planned, active, blocked, deferred | drafted, awaiting-validation, superseded | complete | active -> drafted -> awaiting-validation -> complete |
| implementation | planned, active, blocked, deferred | implemented, implemented-unproven | complete | active -> implemented -> complete |
| test-strategy | planned, active, blocked, deferred | defined, awaiting-review, superseded | complete | active -> defined -> awaiting-review -> complete |
| validation | planned, active, blocked, deferred | validated, inconclusive | complete | active -> validated or inconclusive -> complete |
| review | planned, active, blocked, deferred | awaiting-decision, reviewed, superseded | complete | active -> awaiting-decision -> reviewed -> complete |
| rework | planned, active, blocked, deferred | corrected, awaiting-review | complete | active -> corrected -> awaiting-review -> complete |
| delivery | planned, active, blocked, deferred | awaiting-release, delivered | complete | active -> awaiting-release -> delivered -> complete |

`implemented-unproven` cannot transition directly to `complete`; it must first
progress to `implemented`. `superseded` is supported only by decision, design,
test-strategy, and review tasks. It retains the prior valid result and does not
require a new result solely because the task became superseded.

## Result-field policy

Each task schema defines its complete top-level result field set `R_T`. Lifecycle
metadata must provide the following for every status:

- `resultPresence`;
- `allowedResultPaths`;
- `requiredResultPaths`;
- `forbiddenResultPaths`; and
- allowed transitions from that status.

The generic validator applies these rules before or alongside the selected task
schema:

1. Every populated result path must be in `allowedResultPaths`.
2. Every `requiredResultPath` must be present.
3. Every `forbiddenResultPath` must be absent.
4. Required and forbidden paths must not conflict.
5. Nested types, enums, required fields, formats, and `additionalProperties`
   remain governed by ordinary JSON Schema.
6. Result field presence does not establish that a claim is true or that an
   execution occurred.

The common presence policy is:

| Status class | Presence and field rule |
| --- | --- |
| planned | No result fields allowed. The result may be omitted, null, or empty according to the envelope/host representation. |
| active | Any task-specific result fields may be retained or added; none are required. |
| blocked | Any task-specific result fields may be retained; none are required. No `statusReason` field is introduced. |
| deferred | Any task-specific result fields may be retained; none are required. |
| milestone | Full status-specific result contract is required. |
| complete | Full terminal result contract is required. |
| superseded | The prior milestone result remains valid; no new result is required solely for supersession. |

## Result fields by task type

| Task type | Top-level result fields |
| --- | --- |
| decomposition | `status`, `tasks`, `limitations` |
| research | `findings`, `unresolvedQuestions`, `recommendations`, `evidenceLimitations` |
| decision | `selected`, `consequences`, `reversibility`, `affectedRefs`, `status`, `approval` |
| design | `summary`, `model`, `elements`, `relations`, `views`, `artifacts`, `outcomes`, `outputs`, `verificationObligations`, `unresolvedQuestions` |
| implementation | `status`, `implementation`, `verification`, `limitations` |
| test-strategy | `status`, `testCases`, `fixtures`, `coverage`, `minimumRequiredTestCaseRefs`, `recommendedTestCaseRefs`, `evidenceLimitations` |
| validation | `status`, `summary`, `executions`, `findings`, `evidenceTier`, `limitations`, `nonClaims` |
| review | `status`, `decision`, `summary`, `actor`, `criteriaEvaluations`, `findings`, `evidence`, `limitations`, `nonClaims`, `reproducibility`, `executionReceipt` |
| rework | `status`, `summary`, `corrections`, `evidence`, `limitations`, `nonClaims` |
| delivery | `status`, `summary`, `artifacts`, `executions`, `limitations` |

At a task-specific milestone and at `complete`, the full field set currently
defined by that task result schema is required. Phase 1 must preserve the
distinction between task lifecycle status and the result's own outcome status;
for example, a complete validation task may contain a failed validation result.

## Declarative metadata shape

The intended metadata shape is:

```json
{
  "x-sdlc-task-lifecycle": {
    "statusProperty": "/status",
    "resultProperty": "/result",
    "initialStatuses": ["planned"],
    "statuses": {
      "planned": {
        "kind": "transitional",
        "resultPresence": "empty-only",
        "allowedResultPaths": [],
        "requiredResultPaths": [],
        "forbiddenResultPaths": ["/result/example"]
      },
      "active": {
        "kind": "transitional",
        "resultPresence": "partial",
        "allowedResultPaths": ["/result/example"],
        "requiredResultPaths": [],
        "forbiddenResultPaths": []
      },
      "complete": {
        "kind": "terminal",
        "resultPresence": "required",
        "allowedResultPaths": ["/result/example"],
        "requiredResultPaths": ["/result/example"],
        "forbiddenResultPaths": []
      }
    },
    "transitions": {
      "planned": ["active", "blocked", "deferred"],
      "active": ["blocked", "deferred", "<task-specific-milestone>"],
      "blocked": ["active"],
      "deferred": ["planned", "active", "blocked"],
      "complete": []
    }
  }
}
```

The example is illustrative. Each actual task schema must use concrete paths and
concrete task-specific statuses. Metadata is documented contract information and
must be covered by schema-audit tests before a new convention is introduced.

## Enforcement boundaries

Phase 1 provides read-only structural and lifecycle validation. It does not claim
to prevent direct file edits. Later phases own the enforcement boundary:

- readiness consumes the lifecycle graph when deciding whether a task may start;
- controlled mutation validates transitions and writes candidate records;
- receipts bind authorized mutations to source and graph state;
- merge checks reject unauthorized task-file changes; and
- completion checks consume current lifecycle and evidence state.

## Required matrix coverage

Tests must cover every task type and representative valid and invalid cases for:

- planned with omitted, null, and empty result representations;
- planned with a populated result field;
- partial active, blocked, and deferred result retention;
- milestone and terminal required paths;
- allowlist violations;
- forbidden-path violations;
- invalid status/result combinations;
- planned, active, blocked, deferred, milestone, superseded, and complete
  transition edges;
- terminal closure and recovery through a new task rather than reopening; and
- independence of processingStatus, task status, result status, review decision,
  validation outcome, and work-item status.

## Non-claims

Passing Phase 1 validation proves only that the declared lifecycle metadata,
candidate record shape, selected task schema, and tested transition/result rules
are internally consistent. It does not prove implementation correctness,
execution, provider behavior, deployment safety, production readiness, or that a
result claim is true merely because its fields are present.
# WI-0034 task lifecycle status contract

## Purpose

This document is the authoritative design boundary for the WI-0034 schema break. It separates three independent facts:

1. **Envelope `processingStatus`** describes host processing of a task record: `unprocessed`, `processing_in_progress`, `processing_completed`, `processing_blocked`, or `processing_failed`.
2. **Task `status`** describes the selected task type's lifecycle. Its enum and meaning are owned by the selected task-specific schema.
3. **Result `status`** describes the task-specific observed outcome when that result contract defines one. It is not a lifecycle transition.

The task-specific projection validated by the host is:

```json
{
  "status": "<task-specific lifecycle status>",
  "intent": {},
  "result": {}
}
```

## Required task contract

Every task-specific contract must require `status`, `intent`, and `result` at its root. The envelope continues to carry the selected value at `task.status`; the validator projects that value into the task-specific contract. The task schema owns the enum.

Incomplete task statuses may allow an omitted, null, empty, or partial result. Domain milestone statuses require the fields needed to record the milestone. `complete` requires the full result contract and all applicable task-specific gates.

## Lifecycle status matrix

| Task type | Proposed statuses | Result milestone | Completion meaning |
|---|---|---|---|
| decomposition | planned, active, blocked, decomposed, complete, deferred | decomposed | Child materialization, range, parentage, and reference gates are finalized. |
| research | planned, active, blocked, researched, complete, deferred | researched | Findings, questions, recommendations, and evidence limitations are recorded and gated. |
| decision | planned, active, blocked, awaiting-approval, decided, complete, superseded, deferred | decided | Selected outcome and required approval gates are finalized. |
| design | planned, active, blocked, drafted, awaiting-validation, complete, superseded, deferred | drafted | Design policy, semantic, and validation gates are finalized. |
| implementation | planned, active, blocked, implemented, implemented-unproven, complete, deferred | implemented | Implementation and required verification/review gates are finalized. |
| test-strategy | planned, active, blocked, defined, awaiting-review, complete, superseded, deferred | defined | Strategy coverage and applicable review gates are finalized. |
| validation | planned, active, blocked, validated, inconclusive, complete, deferred | validated | Procedures, executions, evidence, findings, and non-claims are finalized; target outcome may still fail. |
| review | planned, active, blocked, awaiting-decision, reviewed, complete, superseded, deferred | reviewed | Review execution, decision, reproducibility, and approval gates are finalized. |
| rework | planned, active, blocked, corrected, awaiting-review, complete, deferred | corrected | Correction output and the required subsequent accepted review are finalized. |
| delivery | planned, active, blocked, awaiting-release, delivered, complete, deferred | delivered | Delivery execution, artifact integrity, authorization, and release gates are finalized. |

## Result requirement policy

| Status class | Result requirement |
|---|---|
| planned, active, deferred | Result may be omitted, null, empty, or partial. |
| blocked | Result may be absent while the block is being recorded; finalized blocked tasks should record the task-specific blocker and limitations. |
| Domain milestone | Result fields required by the task-specific milestone metadata must be present and schema-valid. |
| complete | Full task-specific result contract and all applicable semantic gates must be valid. |
| superseded | The task may retain its prior result; no new result is required solely because it was superseded. |

## Declarative metadata

Each task schema will declare lifecycle policy with `x-sdlc-task-lifecycle`. The metadata must identify the status and result JSON Pointers, describe each allowed status, declare required result paths by status, and optionally declare result-status compatibility rules. JSON Schema keywords remain authoritative for types, enums, nested required fields, formats, and additional properties.

Example shape:

```json
{
  "x-sdlc-task-lifecycle": {
    "statusProperty": "/status",
    "resultProperty": "/result",
    "statuses": {
      "planned": {
        "kind": "transitional",
        "result": "optional"
      },
      "implemented": {
        "kind": "milestone",
        "requiredResultPaths": ["/status", "/implementation"]
      },
      "complete": {
        "kind": "terminal",
        "requiredResultPaths": ["/status", "/implementation", "/verification", "/limitations"]
      }
    }
  }
}
```

## Non-goals

This change does not redefine envelope processing states, does not collapse result outcomes into lifecycle states, does not infer approval or production readiness from `complete`, and does not permit a task-specific schema to add undocumented `x-sdlc-*` metadata.
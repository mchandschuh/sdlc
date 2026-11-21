# WI-0036 collection listing table

This is the reviewed schema-to-CLI inventory for the declarative collection-listing feature. It lists meaningful object-backed collections and intentionally excludes JSON Schema metadata, scalar reference/path lists, enum arrays, ordered step strings, and validator implementation details from the first-class command surface.

Human-readable commands show the authoritative identifier plus the declared textual field. `--json` returns the complete selected objects in the versioned collection response envelope.

## Work-item and common task collections

| Type | Array | Identifier | Text/title | Proposed CLI |
| --- | --- | --- | --- | --- |
| `work-item/v3` | `requirements.items` | `id` | `description` / `name` | `sdlc work-item requirement list --work-item <work-item-id>` |
| `work-item/v3` | `requirements.items[].acceptanceCriteria` | `id` | `description` | `sdlc work-item acceptance-criterion list --work-item <work-item-id> --requirement <requirement-id>` |
| `work-item/v3` | `scope` | `name` | `description` | `sdlc work-item scope list --work-item <work-item-id>` |
| `work-item/v3` | `nonGoals` | `name` | `description` | `sdlc work-item non-goal list --work-item <work-item-id>` |
| `task-envelope/v1` | `dependsOn` | task UID | task UID | `sdlc task dependency list --task <task-id>` |
| `task-envelope/v1` | `governance.validationProcedures` | `id` | `expected` / `executable` | `sdlc task validation-procedure list --task <task-id>` |

## Task-specific collections

| Type | Array | Identifier | Text/title | Proposed CLI |
| --- | --- | --- | --- | --- |
| `task: decomposition` | `result.tasks` | `ref` | `taskType` | `sdlc task child list --task <task-id>` |
| `task: decomposition` | `intent.range.subranges` | `name` | `description` | `sdlc task subrange list --task <task-id>` |
| `task: research` | `intent.questions` | `id` | `question` | `sdlc task question list --task <task-id>` |
| `task: research` | `intent.sources` | `id` | `purpose` / `location` | `sdlc task source list --task <task-id>` |
| `task: research` | `result.findings` | `id` | `statement` | `sdlc task finding list --task <task-id>` |
| `task: research` | `result.unresolvedQuestions` | `id` | `question` | `sdlc task unresolved-question list --task <task-id>` |
| `task: research` | `result.recommendations` | `id` | `recommendation` | `sdlc task recommendation list --task <task-id>` |
| `task: decision` | `intent.alternatives` | `id` | `description` / `name` | `sdlc task alternative list --task <task-id>` |
| `task: decision` | `intent.criteria` | `id` | `description` / `name` | `sdlc task criterion list --task <task-id>` |
| `task: decision` | `intent.assumptions` | `id` | `statement` | `sdlc task assumption list --task <task-id>` |
| `task: decision` | `result.consequences.risks` | `id` | `description` | `sdlc task risk list --task <task-id>` |
| `task: design` | `intent.considerations` | `id` | `statement` / `evaluation` | `sdlc task consideration list --task <task-id>` |
| `task: design` | `intent.activities` | `id` | `summary` | `sdlc task activity list --task <task-id>` |
| `task: design` | `result.elements` | `id` | `description` / `name` | `sdlc task element list --task <task-id>` |
| `task: design` | `result.relations` | `id` | `description` | `sdlc task relation list --task <task-id>` |
| `task: design` | `result.views` | `id` | `description` / `name` | `sdlc task view list --task <task-id>` |
| `task: design` | `result.artifacts` | `id` | `description` / `name` | `sdlc task artifact list --task <task-id>` |
| `task: design` | `result.outcomes` | `id` | `statement` | `sdlc task outcome list --task <task-id>` |
| `task: design` | `result.verificationObligations` | `id` | `description` | `sdlc task verification-obligation list --task <task-id>` |
| `task: implementation` | `intent.inputs` | `id` | `purpose` | `sdlc task input list --task <task-id>` |
| `task: implementation` | `intent.objectives` | `id` | `statement` | `sdlc task objective list --task <task-id>` |
| `task: implementation` | `result.implementation.changes` | `id` | `summary` | `sdlc task change list --task <task-id>` |
| `task: implementation` | `result.implementation.testImplementations` | `testCaseRef` | `selector` / `path` | `sdlc task test-implementation list --task <task-id>` |
| `task: implementation` | `result.verification.tests` | `id` | `result` / `command` | `sdlc task verification-test list --task <task-id>` |
action-criterion>` |
| `task: test-strategy` | `intent.requirements` | `id` | `statement` | `sdlc task requirement list --task <task-id> --kind <requirement-or-acceptance-criterion>` |
| `task: test-strategy` | `intent.invariants` | `id` | `statement` | `sdlc task invariant list --task <task-id>` |
| `task: test-strategy` | `intent.objectives` | `id` | `statement` | `sdlc task objective list --task <task-id>` |
| `task: test-strategy` | `result.testCases` | `id` | `purpose` / `title` | `sdlc task test-case list --task <task-id>` |
| `task: test-strategy` | `result.fixtures` | `id` | `purpose` / `name` | `sdlc task fixture list --task <task-id>` |
| `task: test-strategy` | `result.coverage` | `id` | `rationale` | `sdlc task coverage list --task <task-id>` |
| `task: validation` | `intent.inputs` | `id` | `purpose` | `sdlc task input list --task <task-id>` |
| `task: validation` | `intent.targets` | `id` | `purpose` | `sdlc task target list --task <task-id>` |
| `task: validation` | `intent.procedures` | `id` | `description` / `reason` | `sdlc task procedure list --task <task-id>` |
| `task: validation` | `result.executions` | `id` | `observed.summary` | `sdlc task execution list --task <task-id>` |
| `task: validation` | `result.findings` | `code` | `message` | `sdlc task finding list --task <task-id>` |
| `task: review` | `intent.criteria` | `id` | `statement` | `sdlc task criterion list --task <task-id>` |
| `task: review` | `intent.evidenceRequirements` | `id` | `purpose` | `sdlc task evidence-requirement list --task <task-id>` |
| `task: review` | `result.criteriaEvaluations` | `criterionRef` | `summary` | `sdlc task criterion-evaluation list --task <task-id>` |
| `task: review` | `result.findings` | `id` | `message` | `sdlc task finding list --task <task-id>` |
| `task: review` | `result.evidence` | `id` | `claim` | `sdlc task evidence list --task <task-id>` |
| `task: rework` | `intent.objectives` | `id` | `statement` | `sdlc task objective list --task <task-id>` |
| `task: rework` | `intent.acceptanceCriteria` | `id` | `description` | `sdlc task acceptance-criterion list --task <task-id>` |
| `task: rework` | `result.corrections` | `id` | `summary` | `sdlc task correction list --task <task-id>` |
| `task: delivery` | `intent.inputs` | `id` | `purpose` | `sdlc task input list --task <task-id>` |
| `task: delivery` | `intent.artifacts` | `id` | `purpose` / `path` | `sdlc task artifact list --task <task-id> --phase intent` |
| `task: delivery` | `intent.procedures` | `id` | `description` / `expected.result` | `sdlc task procedure list --task <task-id>` |
| `task: delivery` | `result.artifacts` | `id` | `path` | `sdlc task artifact list --task <task-id> --phase result` |
| `task: delivery` | `result.executions` | `id` | `result.summary` | `sdlc task execution list --task <task-id>` |

## Deliberately excluded from first-class list commands

The following remain JSON/report data rather than initial entity-style commands:

- scalar path, reference, enum, and ordered-step arrays;
- validator response arrays such as `objects`, `references`, `findings`, and `evidence`;
- plain-string collections without authoritative stable identifiers, such as some design `objectives`, `inScope`, and `outOfScope` values.

These remain available through the complete `--json` document or report response.

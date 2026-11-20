# Repository Agent Conventions

## Persist schemas for every input and output object

Every input or output object introduced, persisted, serialized, or exposed by
this repository **must have a versioned schema persisted under the repository's
`schemas/` directory**.

This applies to, at minimum:

- CLI JSON input and output objects;
- work-item, task, evidence, and result records;
- configuration and command-file objects;
- library request and response objects; and
- HTTP request, response, and error envelopes.

### Required practice

1. Add the schema before or with the code that introduces the object.
2. Store it below the canonical high-level-object/version path, for example:
   `schemas/sdlc-stat/v1/sdlc-state.schema.json`.
3. Give the schema a stable versioned `$id` under
   `https://schemas.handschuh.dev/sdlc/`.
4. Use JSON Schema 2020-12 and keep the contract closed unless an explicit
   extension boundary is documented.
5. Reference the persisted schema from implementation, task records, or
   response metadata when consumers need to select the contract.
6. Validate the schema itself and at least one representative instance before
   committing the feature.

### Reference schema registry convention

Every standalone string schema that is supported by `sdlc ref validate --ref
<reference>` **must** declare the root metadata property
`"x-sdlc-reference-type": true`.

The marked schema must also:

- have `type: "string"`;
- have a stable `$id` under `https://schemas.handschuh.dev/sdlc/`; and
- provide at least one valid root-level `examples` value.

Canonical task-local references use explicit task JSON paths rooted at `intent`
or `result`, for example `#intent/objectives/OBJ-001` and
`#result/implementation/changes/CHANGE-001`. The envelope's `task` property is
elided because the local reference is already scoped to the current task.

Identifier schemas may be marked when their standalone identity forms are
accepted by direct reference validation. The canonical bare work-item form is
`WI-0001`; the canonical bare task form is `WI-0001-80000000`.

The reference validator and its tests must discover marked schemas recursively
under `schemas/`; they must not maintain a hardcoded filename or type list. Each
root example is an executable fixture for the dynamic reference-validation test,
so adding a new marked reference schema and example automatically expands that
test's coverage. A schema that only wraps a reference inside an object is not a
direct `<reference>` type unless the command explicitly supports that whole
object form and the schema is marked accordingly.

An inline TypeScript interface, a string such as `sdlc-example/v1`, a README
example, or an unversioned ad hoc JSON shape is not a substitute for a persisted
schema. If an object has multiple versions, persist each version separately and
never silently change an existing version's meaning.

### Completion rule

A feature that introduces an input or output object is incomplete until its
corresponding schema is present under `schemas/`, included in the repository
schema audit, and covered by the feature's validation evidence.

## Keep the SDLC agent skill current

When a change updates SDLC CLI commands, work-item lifecycle behavior, branch or
release enforcement, task-file conventions, or the agent's required process,
update the SDLC agent skill at:

```text
/home/michael/.cline/skills/sdlc/SKILL.md
```

The skill must remain an operational guide, not a historical note. Keep its CLI
examples, branch/start/validate workflow, task-processing rules, hook behavior,
merge/tag/push requirements, and validation commands aligned with the current
repository implementation. Include the skill update in the same work item and
record the path in the task's references or owned paths when the repository
process changes.

At minimum, review the skill whenever changing:

- `sdlc work-item` or `sdlc task` commands;
- work-item or task schema versions;
- branch, merge, hook, tag, or push enforcement; or
- required agent sequencing, commit, validation, or release behavior.

## Git hook installation

Git hook behavior is centralized in `scripts/git_hooks.mjs`. The module exposes
`dispatch(args)`, a complete `ALL_GIT_HOOKS` listing, and one named handler for
each documented Git hook:

```text
applypatch-msg, pre-applypatch, post-applypatch, pre-commit,
pre-merge-commit, prepare-commit-msg, commit-msg, post-commit, pre-rebase,
post-checkout, post-merge, pre-push, pre-receive, update, proc-receive,
post-receive, post-update, reference-transaction, push-to-checkout,
pre-auto-gc, post-rewrite, sendemail-validate, fsmonitor-watchman,
p4-changelist, p4-prepare-changelist, p4-post-changelist, p4-pre-submit,
post-index-change
```

Installed hooks are uniform thin wrappers that pass the hook name, original
arguments, and inherited stdin to the dispatcher. The installer derives its
complete hook-file list from `ALL_GIT_HOOKS`, so adding a documented hook only
requires updating `scripts/git_hooks.mjs`, not an individual Git hook file.
Install or refresh all wrappers with:

```bash
node ./scripts/install.mjs --hooks
```

`scripts/install.mjs` is the only hook installer. Repeated installation is
idempotent and preserves unmanaged hook content. The former
`scripts/install_sdlc_validate_git_hooks.mjs` installer is removed; pre-commit
validation, post-merge reminders, and primary-branch pre-push release checks
remain dispatcher handlers.

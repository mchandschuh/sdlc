export const WORK_ITEM_ID_PATTERN = /^[A-Z]{1,10}-[0-9]+$/u;
export const TASK_UID_PATTERN = /^[A-Z]{1,10}-[0-9]+-[0-9]{8}$/u;

const TASK_OWNED_LOCAL_ID = /^(?:INPUT|OBJ|TARGET|VAL|TC|CHANGE|EXEC|ART|FIND|PROC|INV|R|O|Q|UQ|AC)-[A-Za-z0-9][A-Za-z0-9-]*$/u;
const TASK_OWNED_ID = /^([A-Z]{1,10}-[0-9]+-[0-9]{8})_((?:INPUT|OBJ|TARGET|VAL|TC|CHANGE|EXEC|ART|FIND|PROC|INV|R|O|Q|UQ|AC)-[A-Za-z0-9][A-Za-z0-9-]*)$/u;

export function isTaskOwnedLocalId(value: string): boolean {
  return TASK_OWNED_LOCAL_ID.test(value);
}

export function isTaskOwnedId(value: string): boolean {
  return TASK_OWNED_ID.test(value);
}

export function taskOwnedId(taskUid: string, value: string): string {
  if (!TASK_UID_PATTERN.test(taskUid)) throw new Error(`Invalid task UID: ${taskUid}`);
  if (isTaskOwnedId(value)) return value;
  if (!isTaskOwnedLocalId(value)) throw new Error(`Invalid task-owned identifier: ${value}`);
  return `${taskUid}_${value}`;
}

export function taskOwnedParts(value: string): { readonly taskUid: string; readonly localId: string } | undefined {
  const match = TASK_OWNED_ID.exec(value);
  return match ? { taskUid: match[1]!, localId: match[2]! } : undefined;
}

export function taskEntityKind(value: string): string {
  const localId = taskOwnedParts(value)?.localId ?? value;
  const prefix = localId.split('-', 1)[0];
  const kinds: Readonly<Record<string, string>> = {
    INPUT: 'input',
    OBJ: 'objective',
    TARGET: 'target',
    VAL: 'procedure',
    TC: 'test-case',
    CHANGE: 'change',
    EXEC: 'execution',
    ART: 'artifact',
    FIND: 'finding',
    PROC: 'procedure',
    INV: 'invariant',
    R: 'result',
    O: 'outcome',
    Q: 'question',
    UQ: 'unresolved-question',
    AC: 'acceptance-criterion',
  };
  return kinds[prefix!] ?? 'entity';
}
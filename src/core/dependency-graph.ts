import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError, type TaskSummary } from './discovery.js';

export type DependencyFindingCode = 'DUPLICATE_TASK_UID' | 'DUPLICATE_ORDER_KEY' | 'MISSING_DEPENDENCY' | 'SELF_DEPENDENCY' | 'DEPENDENCY_CYCLE';

export interface DependencyFinding {
  readonly code: DependencyFindingCode;
  readonly severity: 'blocking';
  readonly taskUids?: readonly string[];
  readonly message: string;
}

export interface DependencyNode {
  readonly taskUid: string;
  readonly orderKey: string;
  readonly taskType: string;
  readonly path: string;
  readonly processingStatus: string;
  readonly taskStatus: string;
  readonly dependsOn: readonly string[];
}

export interface LinearizedNode {
  readonly rank: number;
  readonly taskUid: string;
  readonly dependencies: readonly string[];
}

export interface DependencyGraphReport {
  readonly schema: 'https://schemas.handschuh.dev/sdlc/cli-dependency-linearization/v1';
  readonly workItemId: string;
  readonly valid: boolean;
  readonly algorithm: 'explicit-depends-on-topological-order-v1';
  readonly nodes: readonly DependencyNode[];
  readonly linearization: readonly LinearizedNode[];
  readonly findings: readonly DependencyFinding[];
}

interface TaskEnvelopeRecord {
  readonly taskUid: string;
  readonly taskType: string;
  readonly orderKey: string;
  readonly processingStatus: string;
  readonly taskStatus: string;
  readonly dependsOn: readonly string[];
  readonly path: string;
}

function compareNodes(left: DependencyNode, right: DependencyNode): number {
  return left.orderKey.localeCompare(right.orderKey, undefined, { numeric: true }) || left.taskUid.localeCompare(right.taskUid);
}

function finding(code: DependencyFindingCode, message: string, taskUids?: readonly string[]): DependencyFinding {
  return { code, severity: 'blocking', ...(taskUids ? { taskUids } : {}), message };
}

async function readTaskEnvelopes(repositoryRoot: string, workItemId: string, summaries: readonly TaskSummary[]): Promise<{ readonly records: readonly TaskEnvelopeRecord[]; readonly findings: readonly string[] }> {
  const records: TaskEnvelopeRecord[] = [];
  const findings: string[] = [];
  for (const summary of summaries) {
    try {
      const source = await readFile(join(repositoryRoot, summary.path), 'utf8');
      const envelope = (summary.path.endsWith('.json') ? JSON.parse(source) : YAML.parse(source)) as Record<string, unknown>;
      const task = envelope.task as Record<string, unknown> | undefined;
      const dependsOn = Array.isArray(envelope.dependsOn) && envelope.dependsOn.every((value) => typeof value === 'string') ? envelope.dependsOn as string[] : [];
      const orderKey = typeof envelope.orderKey === 'string' ? envelope.orderKey : '';
      if (!task || !orderKey) throw new DiscoveryError(`Invalid dependency graph task envelope: ${summary.path}`);
      records.push({ taskUid: summary.taskUid, taskType: summary.taskType, orderKey, processingStatus: summary.processingStatus, taskStatus: summary.taskStatus, dependsOn, path: summary.path });
    } catch (error) {
      findings.push(error instanceof Error ? error.message : `Unable to read dependency graph task: ${summary.path}`);
    }
  }
  return { records, findings };
}

function cycleWitness(nodes: readonly DependencyNode[], adjacency: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (uid: string): readonly string[] | undefined => {
    state.set(uid, 1);
    stack.push(uid);
    for (const next of adjacency.get(uid) ?? []) {
      if (state.get(next) === 1) {
        const index = stack.indexOf(next);
        return [...stack.slice(index), next];
      }
      if (!state.get(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(uid, 2);
    return undefined;
  };
  for (const node of [...nodes].sort(compareNodes)) if (!state.has(node.taskUid)) {
    const cycle = visit(node.taskUid);
    if (cycle) return cycle;
  }
  return undefined;
}

export async function buildDependencyGraph(repositoryRoot: string, workItemId: string): Promise<DependencyGraphReport> {
  const discovered = await discoverTasks(repositoryRoot, workItemId);
  const loaded = await readTaskEnvelopes(repositoryRoot, workItemId, discovered.items);
  const nodes = loaded.records.map((record) => ({ taskUid: record.taskUid, orderKey: record.orderKey, taskType: record.taskType, path: record.path, processingStatus: record.processingStatus, taskStatus: record.taskStatus, dependsOn: [...record.dependsOn].sort() })).sort(compareNodes);
  const findings: DependencyFinding[] = loaded.findings.map((message) => finding('MISSING_DEPENDENCY', message));
  const byUid = new Map<string, DependencyNode>();
  const byOrder = new Map<string, DependencyNode>();
  for (const node of nodes) {
    if (byUid.has(node.taskUid)) findings.push(finding('DUPLICATE_TASK_UID', `Duplicate task UID: ${node.taskUid}.`, [node.taskUid]));
    else byUid.set(node.taskUid, node);
    const duplicate = byOrder.get(node.orderKey);
    if (duplicate) findings.push(finding('DUPLICATE_ORDER_KEY', `Duplicate order key ${node.orderKey}: ${duplicate.taskUid}, ${node.taskUid}.`, [duplicate.taskUid, node.taskUid].sort()));
    else byOrder.set(node.orderKey, node);
  }
  const adjacency = new Map<string, readonly string[]>();
  for (const node of nodes) adjacency.set(node.taskUid, []);
  for (const node of nodes) for (const dependency of node.dependsOn) {
    if (dependency === node.taskUid) findings.push(finding('SELF_DEPENDENCY', `Task ${node.taskUid} depends on itself.`, [node.taskUid]));
    else if (!byUid.has(dependency)) findings.push(finding('MISSING_DEPENDENCY', `Task ${node.taskUid} depends on missing task ${dependency}.`, [node.taskUid, dependency].sort()));
    else adjacency.set(dependency, [...(adjacency.get(dependency) ?? []), node.taskUid]);
  }
  for (const [uid, targets] of adjacency) adjacency.set(uid, [...targets].sort((left, right) => compareNodes(byUid.get(left)!, byUid.get(right)!)));
  const cycle = cycleWitness(nodes, adjacency);
  if (cycle) findings.push(finding('DEPENDENCY_CYCLE', 'Explicit task dependencies form a cycle.', cycle));
  findings.sort((left, right) => left.code.localeCompare(right.code) || (left.taskUids ?? []).join('\0').localeCompare((right.taskUids ?? []).join('\0')) || left.message.localeCompare(right.message));
  if (findings.length > 0) return { schema: 'https://schemas.handschuh.dev/sdlc/cli-dependency-linearization/v1', workItemId, valid: false, algorithm: 'explicit-depends-on-topological-order-v1', nodes, linearization: [], findings };
  const indegree = new Map(nodes.map((node) => [node.taskUid, node.dependsOn.length]));
  const available: DependencyNode[] = nodes.filter((node) => indegree.get(node.taskUid) === 0).sort(compareNodes);
  const linearization: LinearizedNode[] = [];
  while (available.length > 0) {
    const node = available.shift()!;
    linearization.push({ rank: linearization.length + 1, taskUid: node.taskUid, dependencies: node.dependsOn });
    for (const dependent of adjacency.get(node.taskUid) ?? []) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        available.push(byUid.get(dependent)!);
        available.sort(compareNodes);
      }
    }
  }
  if (linearization.length !== nodes.length) {
    return { schema: 'https://schemas.handschuh.dev/sdlc/cli-dependency-linearization/v1', workItemId, valid: false, algorithm: 'explicit-depends-on-topological-order-v1', nodes, linearization: [], findings: [finding('DEPENDENCY_CYCLE', 'Explicit task dependencies form a cycle.')] };
  }
  return { schema: 'https://schemas.handschuh.dev/sdlc/cli-dependency-linearization/v1', workItemId, valid: true, algorithm: 'explicit-depends-on-topological-order-v1', nodes, linearization, findings: [] };
}
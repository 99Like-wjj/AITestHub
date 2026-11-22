import {
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import type { PreparedReference } from './workspace-references';
import type {
  OperationTarget,
  SendMessageInput,
} from '../../../packages/contracts/src/conversations';
import type { WorkspaceAccessMode } from '../../../packages/contracts/src/workspace-access';
import type { PlatformGuidanceSkillId } from '../../../packages/contracts/src/skill-guidance';

export interface ComposerInsertion {
  start: number;
  end: number;
  text: string;
  restoreText?: string | undefined;
}
export interface WorkspaceDraft {
  content: string;
  references: PreparedReference[];
  operationTarget?: OperationTarget | null | undefined;
  skillIds?: PlatformGuidanceSkillId[] | undefined;
}

/** An edited queued message keeps its original target, including a personal
 * null target, until the user explicitly chooses a different context. */
export function resolveWorkspaceDraftTarget(
  draft: WorkspaceDraft | undefined,
  accessMode: WorkspaceAccessMode,
  currentTarget: OperationTarget | null,
): OperationTarget | null {
  if (accessMode === 'restricted') return null;
  return draft?.operationTarget === undefined
    ? currentTarget
    : draft.operationTarget;
}
/** Rendering/autosave of unchanged fields must not replace a dispatched draft.
 * An actual edit still gets a distinct identity, including edit-then-undo. */
export function saveWorkspaceDraft(
  drafts: Map<string, WorkspaceDraft>,
  key: string,
  next: WorkspaceDraft,
): WorkspaceDraft {
  const current = drafts.get(key);
  if (
    current?.content === next.content &&
    current.references === next.references &&
    current.operationTarget === next.operationTarget &&
    current.skillIds === next.skillIds
  )
    return current;
  drafts.set(key, next);
  return next;
}
export interface PendingWorkspaceSend {
  conversationId: string;
  commandId: string;
  input: SendMessageInput;
  draft: WorkspaceDraft;
}

const owners = new Map<string, Map<string, WorkspaceDraft>>();
const sends = new Map<string, Map<string, PendingWorkspaceSend>>();
const creations = new Map<string, Map<string, WorkspaceDraft>>();
let savedEpoch = -1;
let observing = false;

/** Session memory only: no draft text or references are written to browser storage. */
export function workspaceDrafts(ownerId: string) {
  if (!observing) {
    observing = true;
    subscribeIdentityChanges(() => {
      for (const drafts of owners.values()) drafts.clear();
      owners.clear();
      for (const pending of sends.values()) pending.clear();
      sends.clear();
      for (const pending of creations.values()) pending.clear();
      creations.clear();
      savedEpoch = identityContextEpoch();
    });
  }
  if (savedEpoch !== identityContextEpoch()) {
    for (const drafts of owners.values()) drafts.clear();
    owners.clear();
    for (const pending of sends.values()) pending.clear();
    sends.clear();
    for (const pending of creations.values()) pending.clear();
    creations.clear();
    savedEpoch = identityContextEpoch();
  }
  let drafts = owners.get(ownerId);
  if (!drafts) {
    drafts = new Map();
    owners.set(ownerId, drafts);
  }
  return drafts;
}

export function pendingWorkspaceSends(ownerId: string) {
  workspaceDrafts(ownerId);
  let pending = sends.get(ownerId);
  if (!pending) {
    pending = new Map();
    sends.set(ownerId, pending);
  }
  return pending;
}

export function pendingCreationDrafts(ownerId: string) {
  workspaceDrafts(ownerId);
  let pending = creations.get(ownerId);
  if (!pending) {
    pending = new Map();
    creations.set(ownerId, pending);
  }
  return pending;
}

/** A late acknowledgement can clear only the exact submitted draft object. */
export function clearSubmittedDraft(
  drafts: Map<string, WorkspaceDraft>,
  key: string,
  expected: WorkspaceDraft,
) {
  if (drafts.get(key) !== expected) return false;
  drafts.delete(key);
  return true;
}

/** Move only the exact prepared draft into its accepted conversation. A late
 * creation receipt cannot replace edits already made in either draft. */
export function promoteWorkspaceDraft(
  drafts: Map<string, WorkspaceDraft>,
  conversationId: string,
  expected: WorkspaceDraft,
): string[] {
  const current = drafts.get(conversationId);
  if (current && current !== expected) return [];
  drafts.set(conversationId, expected);
  const consumed: string[] = [];
  for (const [key, draft] of drafts) {
    if (key.startsWith('new:') && draft === expected) {
      drafts.delete(key);
      consumed.push(key);
    }
  }
  return consumed;
}

export const newDraftKey = (projectId: string | null) =>
  `new:${projectId ?? 'personal'}`;

/** Preserve a system insertion across edits elsewhere; editing the token revokes ownership. */
export function moveInsertion(
  before: string,
  after: string,
  insertion: ComposerInsertion,
): ComposerInsertion | null {
  if (before.slice(insertion.start, insertion.end) !== insertion.text)
    return null;
  if (before === after) return insertion;
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = before.length;
  let afterEnd = after.length;
  while (
    end > start &&
    afterEnd > start &&
    before[end - 1] === after[afterEnd - 1]
  ) {
    end--;
    afterEnd--;
  }
  if (end <= insertion.start) {
    const shift = afterEnd - end;
    return {
      ...insertion,
      start: insertion.start + shift,
      end: insertion.end + shift,
    };
  }
  if (start >= insertion.end) return insertion;
  return null;
}

export function removeInsertions(
  text: string,
  insertions: readonly ComposerInsertion[],
) {
  let value = text;
  const removed: ComposerInsertion[] = [];
  for (const insertion of [...insertions].sort((a, b) => b.start - a.start)) {
    if (value.slice(insertion.start, insertion.end) !== insertion.text)
      continue;
    value = value.slice(0, insertion.start) + value.slice(insertion.end);
    removed.push(insertion);
  }
  return { text: value, removed };
}

import {
  workspaceDraftInputSchema,
  workspaceDraftResponseSchema,
  workspaceDraftDeleteReceiptSchema,
} from '../../../packages/contracts/src/workspace-drafts';
import { api, ApiError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import type { WorkspaceDraft } from './workspace-drafts';

type StoredDraft = NonNullable<Awaited<ReturnType<typeof readWorkspaceDraft>>>;

function draftPath(key: string) {
  return '/me/workspace-drafts/' + encodeURIComponent(key);
}

async function readWorkspaceDraft(key: string, expectedDraftOwner: string) {
  return (
    await api(
      draftPath(key),
      { expectedDraftOwner },
      workspaceDraftResponseSchema,
    )
  ).draft;
}

function snapshot(draft: WorkspaceDraft | null) {
  return draft ? JSON.stringify(workspaceDraftInputSchema.parse(draft)) : '';
}

interface DraftRecord {
  saved?: StoredDraft | null;
  desired?: WorkspaceDraft | null;
  pendingRead?: Promise<StoredDraft | null>;
  pendingWrite?: Promise<void>;
  timer?: number;
  conflicted?: boolean;
}

export class WorkspaceDraftSync {
  private readonly entries = new Map<string, DraftRecord>();
  private readonly epoch = identityContextEpoch();

  constructor(
    private readonly ownerId: string,
    private readonly onFailure: (key: string, error: unknown) => void,
  ) {}

  private current() {
    return (
      identityContextEpoch() === this.epoch &&
      currentIdentityOwner() === this.ownerId
    );
  }

  private entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {};
      this.entries.set(key, entry);
    }
    return entry;
  }

  read(key: string): Promise<StoredDraft | null> {
    const entry = this.entry(key);
    if (entry.saved !== undefined) return Promise.resolve(entry.saved);
    if (!entry.pendingRead) {
      entry.pendingRead = readWorkspaceDraft(key, this.ownerId)
        .then((value) => {
          if (this.current()) entry.saved = value;
          return value;
        })
        .finally(() => {
          delete entry.pendingRead;
        });
    }
    return entry.pendingRead;
  }

  save(key: string, draft: WorkspaceDraft | null) {
    if (!this.current()) return;
    const entry = this.entry(key);
    entry.desired = draft;
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => void this.flush(key), 180);
  }

  // Clearing an editor may use only a revision the editor actually observed.
  // A fresh read here could select a different tab's newer draft.
  clear(key: string, draft: WorkspaceDraft) {
    const entry = this.entry(key);
    if (entry.desired && snapshot(entry.desired) !== snapshot(draft)) return;
    void this.flush(key).then(() => {
      if (
        this.matchesSaved(key, draft) &&
        (entry.desired === undefined ||
          snapshot(entry.desired) === snapshot(draft))
      )
        this.save(key, null);
    });
  }

  async flush(key: string, keepalive = false): Promise<void> {
    if (!this.current()) return;
    const entry = this.entry(key);
    window.clearTimeout(entry.timer);
    delete entry.timer;
    if (entry.conflicted || entry.desired === undefined) return;
    if (entry.pendingWrite) {
      if (keepalive) return;
      await entry.pendingWrite;
      if (!entry.conflicted && entry.desired !== undefined)
        return this.flush(key);
      return;
    }
    if (entry.desired === null && !entry.saved) {
      delete entry.desired;
      return;
    }
    if (
      keepalive &&
      entry.saved === undefined &&
      !key.startsWith('new:detached:')
    )
      return;
    const pending = entry.desired;
    delete entry.desired;
    const write = async () => {
      const stored =
        keepalive &&
        entry.saved === undefined &&
        key.startsWith('new:detached:')
          ? null
          : await this.read(key);
      if (
        !this.current() ||
        snapshot(pending) === snapshot(stored?.draft ?? null)
      )
        return;
      try {
        if (pending) {
          const response = await api(
            draftPath(key),
            {
              method: 'PUT',
              body: {
                baseRevisionId: stored?.revisionId ?? null,
                draft: pending,
              },
              keepalive,
              expectedDraftOwner: this.ownerId,
            },
            workspaceDraftResponseSchema,
          );
          entry.saved = response.draft;
        } else if (stored) {
          const response = await api(
            draftPath(key),
            {
              method: 'DELETE',
              body: { revisionId: stored.revisionId },
              keepalive,
              expectedDraftOwner: this.ownerId,
            },
            workspaceDraftDeleteReceiptSchema,
          );
          if (
            !response.deleted &&
            (await readWorkspaceDraft(key, this.ownerId)) !== null
          )
            throw new ApiError(
              '草稿已在其他窗口更新。',
              412,
              'STALE_BASE_REVISION',
            );
          entry.saved = null;
        }
      } catch (error) {
        // Compare the exact proposed value after an uncertain write. Never
        // reuse another tab's changed baseline for a silent overwrite.
        if (this.current() && !keepalive) {
          const remote = await readWorkspaceDraft(key, this.ownerId).catch(
            () => undefined,
          );
          if (
            remote !== undefined &&
            snapshot(pending) === snapshot(remote?.draft ?? null)
          ) {
            entry.saved = remote;
            return;
          }
          if (error instanceof ApiError && error.code === 'STALE_BASE_REVISION')
            entry.conflicted = true;
        }
        throw error;
      }
    };
    const running = write().catch((error: unknown) => {
      if (this.current()) this.onFailure(key, error);
    });
    entry.pendingWrite = running;
    await running;
    delete entry.pendingWrite;
  }

  drain(keepalive = false) {
    for (const key of this.entries.keys()) void this.flush(key, keepalive);
  }

  matchesSaved(key: string, draft: WorkspaceDraft) {
    const saved = this.entry(key).saved;
    return Boolean(saved && snapshot(saved.draft) === snapshot(draft));
  }
}

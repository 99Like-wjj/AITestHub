import type { Pool, QueryResult, QueryResultRow } from 'pg';

/** Metadata only; never include plaintext secrets or business/private bodies. */
export interface SecurityControlChange {
  action: string;
  objectId: string;
  projectId: string | null;
}
export interface TransactionControlObserver {
  prepare(
    transaction: SqlExecutor,
    changes: readonly SecurityControlChange[],
  ): Promise<unknown>;
  committed(receipt: unknown): Promise<void>;
  rolledBack(receipt: unknown): Promise<void>;
  uncertainError(): Error;
}

/** Database access is restricted to infrastructure and application repositories. */
export interface SqlExecutor {
  noteSecurityControlChange?(change: SecurityControlChange): void;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export class Database implements SqlExecutor {
  private controlObserver: TransactionControlObserver | undefined;
  constructor(private readonly pool: Pool) {}
  setControlObserver(observer: TransactionControlObserver) {
    this.controlObserver = observer;
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(
      text,
      values === undefined ? undefined : [...values],
    );
  }

  async transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    let discard = false;
    let commitAttempted = false,
      committed = false,
      prepared = false,
      receipt: unknown;
    const changes: SecurityControlChange[] = [];
    const observer = this.controlObserver;
    const transaction: SqlExecutor = {
      noteSecurityControlChange(change) {
        changes.push(change);
      },
      query: <R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) =>
        connection.query<R>(
          text,
          values === undefined ? undefined : [...values],
        ),
    };
    let result: T;
    try {
      await connection.query('BEGIN');
      result = await work(transaction);
      if (observer && changes.length) {
        receipt = await observer.prepare(transaction, changes);
        prepared = true;
      }
      commitAttempted = true;
      await connection.query('COMMIT');
      committed = true;
    } catch (error: unknown) {
      if (!committed)
        try {
          await connection.query('ROLLBACK');
        } catch {
          // Discard a connection whose transaction state is no longer known.
          discard = true;
          if (observer && prepared) throw observer.uncertainError();
          throw error;
        }
      if (observer && prepared) {
        if (commitAttempted) throw observer.uncertainError();
        try {
          await observer.rolledBack(receipt);
        } catch {
          throw observer.uncertainError();
        }
      }
      throw error;
    } finally {
      connection.release(discard);
    }
    // An external durable-control ACK may acquire a short new DB transaction. Release the
    // already committed connection first, so a full pool cannot deadlock waiting for its ACKs.
    if (observer && prepared)
      try {
        await observer.committed(receipt);
      } catch {
        throw observer.uncertainError();
      }
    return result;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

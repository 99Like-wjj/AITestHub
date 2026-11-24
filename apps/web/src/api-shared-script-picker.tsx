import { useEffect, useState } from 'react';
import { Alert, Button, Select } from 'antd';
import type { z } from 'zod';
import {
  apiSharedScriptGetResultSchema,
  apiSharedScriptListResultSchema,
  type ApiSharedScriptReference,
} from '../../../packages/contracts/src/api-shared-scripts';
import { api, describeError } from './api';

type Script = z.output<
  typeof apiSharedScriptListResultSchema
>['scripts'][number];
type Revision = z.output<
  typeof apiSharedScriptGetResultSchema
>['revisions'][number];

export function ApiSharedScriptPicker({
  projectId,
  value,
  disabled,
  onChange,
}: {
  projectId: string;
  value: ApiSharedScriptReference;
  disabled: boolean;
  onChange: (value: ApiSharedScriptReference) => void;
}) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [nextScript, setNextScript] = useState<string | null>(null);
  const [nextRevision, setNextRevision] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [scriptText, setScriptText] = useState<string>();
  const route = `/projects/${projectId}/api-catalog`;

  useEffect(() => {
    const controller = new AbortController();
    void api(
      route,
      {
        method: 'POST',
        body: { op: 'script-list', input: {} },
        signal: controller.signal,
      },
      apiSharedScriptListResultSchema,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setScripts(result.scripts);
          setNextScript(result.nextAfterScriptId);
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [route]);

  useEffect(() => {
    setRevisions([]);
    setNextRevision(null);
    setScriptText(undefined);
    if (!value.scriptId) return;
    const controller = new AbortController();
    void api(
      route,
      {
        method: 'POST',
        body: {
          op: 'script-get',
          input: {
            scriptId: value.scriptId,
            ...(value.scriptRevisionId && {
              revisionId: value.scriptRevisionId,
            }),
          },
        },
        signal: controller.signal,
      },
      apiSharedScriptGetResultSchema,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        const isMissing = !result.revisions.some(
          (item) => item.revisionId === result.revision.revisionId,
        );
        setRevisions(
          isMissing ? [...result.revisions, result.revision] : result.revisions,
        );
        setNextRevision(result.nextBeforeRevisionNo);
        setScripts((prior) =>
          prior.some((script) => script.scriptId === result.script.scriptId)
            ? prior
            : [...prior, result.script],
        );
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [route, value.scriptId]);

  async function viewScript() {
    if (!value.scriptId || !value.scriptRevisionId) return;
    setReading(true);
    setError(undefined);
    try {
      const result = await api(
        route,
        {
          method: 'POST',
          body: {
            op: 'script-get',
            input: {
              scriptId: value.scriptId,
              revisionId: value.scriptRevisionId,
            },
          },
        },
        apiSharedScriptGetResultSchema,
      );
      if (result.revision.revisionId !== value.scriptRevisionId)
        throw new Error('未取得选择的脚本修订。');
      setScriptText(result.revision.body);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setReading(false);
    }
  }

  async function moreRevisions() {
    if (!value.scriptId || reading || nextRevision === null) return;
    setReading(true);
    setError(undefined);
    try {
      const result = await api(
        route,
        {
          method: 'POST',
          body: {
            op: 'script-get',
            input: {
              scriptId: value.scriptId,
              beforeRevisionNo: nextRevision,
            },
          },
        },
        apiSharedScriptGetResultSchema,
      );
      setRevisions((prior) => [
        ...new Map(
          [...prior, ...result.revisions].map((item) => [
            item.revisionId,
            item,
          ]),
        ).values(),
      ]);
      setNextRevision(result.nextBeforeRevisionNo);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setReading(false);
    }
  }

  async function moreScripts() {
    if (!nextScript || reading) return;
    setReading(true);
    setError(undefined);
    try {
      const result = await api(
        route,
        {
          method: 'POST',
          body: { op: 'script-list', input: { afterScriptId: nextScript } },
        },
        apiSharedScriptListResultSchema,
      );
      setScripts((prior) => [
        ...new Map(
          [...prior, ...result.scripts].map((item) => [item.scriptId, item]),
        ).values(),
      ]);
      setNextScript(result.nextAfterScriptId);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="api-catalog-stack">
      <div className="api-catalog-form-grid">
        <label className="api-catalog-form-field">
          <span>项目公共脚本</span>
          <Select
            aria-label="项目公共脚本"
            showSearch
            optionFilterProp="label"
            value={value.scriptId || null}
            disabled={disabled || reading}
            options={scripts.map((script) => ({
              value: script.scriptId,
              label: script.title,
            }))}
            onChange={(scriptId: string) => {
              setError(undefined);
              setScriptText(undefined);
              onChange({ scriptId, scriptRevisionId: '' });
            }}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>固定脚本修订</span>
          <Select
            aria-label="固定脚本修订"
            value={value.scriptRevisionId || null}
            disabled={disabled || reading || !value.scriptId}
            options={[...revisions]
              .sort((a, b) => b.revisionNo - a.revisionNo)
              .map((item) => ({
                value: item.revisionId,
                label: 'r' + item.revisionNo + ' · ' + item.revisionId,
              }))}
            onChange={(scriptRevisionId: string) => {
              setScriptText(undefined);
              onChange({ ...value, scriptRevisionId });
            }}
          />
        </label>
      </div>
      <div className="row wrap">
        {nextScript && (
          <Button
            size="small"
            disabled={reading}
            onClick={() => void moreScripts()}
          >
            加载更多脚本
          </Button>
        )}
        {nextRevision !== null && (
          <Button
            size="small"
            disabled={reading}
            onClick={() => void moreRevisions()}
          >
            加载更早修订
          </Button>
        )}
        {value.scriptRevisionId && (
          <Button
            size="small"
            loading={reading}
            onClick={() => void viewScript()}
          >
            查看固定脚本正文
          </Button>
        )}
      </div>
      {scriptText && <pre className="api-catalog-result">{scriptText}</pre>}
      {error && <Alert type="error" title={error} showIcon />}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Skeleton } from 'antd';
import { idSchema } from '../../../packages/contracts/src/base';
import {
  actionIntentResponseSchema,
  type ActionIntent,
} from '../../../packages/contracts/src/action-intents';
import { api, describeError } from './api';
import { ActionIntentCardView } from './conversation-action-cards';

function Confirmation({ id }: { id: string }) {
  const [intent, setIntent] = useState<ActionIntent>();
  const [visible, setVisible] = useState(true);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string>();
  const path = '/me/mcp-action-intents/' + id;
  const read = useCallback(async () => {
    try {
      setError(undefined);
      const result = await api(path, {}, actionIntentResponseSchema);
      setIntent(result.intent);
      setUncertain(false);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [path]);
  useEffect(() => {
    void read();
  }, [read]);
  async function decide(decision: 'execute' | 'cancel') {
    if (!intent || pending || uncertain) return;
    setPending(true);
    try {
      const result = await api(
        path + '/decision',
        {
          method: 'POST',
          body: {
            revision: intent.revision,
            scopeDigest: intent.scopeDigest,
            decision,
          },
        },
        actionIntentResponseSchema,
      );
      setIntent(result.intent);
      setError(undefined);
    } catch (failure) {
      setUncertain(true);
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open={visible}
      title="本地 AI 操作确认"
      footer={null}
      onCancel={() => setVisible(false)}
      destroyOnHidden
    >
      {error && <Alert type="error" title={error} showIcon />}
      {intent ? (
        <ActionIntentCardView
          intent={intent}
          pending={pending}
          uncertain={uncertain}
          onDecision={(decision) => void decide(decision)}
          onRead={() => void read()}
        />
      ) : (
        !error && <Skeleton active />
      )}
    </Modal>
  );
}

export function McpActionConfirmation() {
  const id = idSchema.safeParse(
    new URLSearchParams(window.location.search).get('athIntent'),
  );
  return id.success ? <Confirmation key={id.data} id={id.data} /> : null;
}

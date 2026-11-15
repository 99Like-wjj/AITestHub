import { useEffect } from 'react';
import {
  webSessionStatusSchema,
  renewWebSessionResultSchema,
} from '../../../packages/contracts/src/web-session';
import { api, isSessionDenial, sessionDenialReason } from './api';
import {
  announceIdentityChange,
  currentIdentityOwner,
  identityContextEpoch,
} from './identity-context';

export const SESSION_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const SESSION_CHECK_INTERVAL_MS = 5 * 60_000;

type SessionTransport = {
  status: () => Promise<{
    session: {
      userId: string;
      scopeId: string;
      serverTime: string;
      renewAfter: string;
    };
  }>;
  renew: (input: { userId: string; scopeId: string }) => Promise<unknown>;
};

/** Polling or SSE do not count as interaction; callers supply real input activity. */
export function createSessionRenewalController(
  ownerId: string,
  transport: SessionTransport,
  {
    now = () => performance.now(),
    visible = () => document.visibilityState === 'visible',
    stillCurrent = () => currentIdentityOwner() === ownerId,
    onSessionDenial = (error: unknown) => {
      if (isSessionDenial(error))
        announceIdentityChange(sessionDenialReason(error));
    },
  } = {},
) {
  let lastActivity = Number.NEGATIVE_INFINITY;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let disposed = false;
  const eligible = () =>
    !disposed &&
    stillCurrent() &&
    visible() &&
    now() - lastActivity >= 0 &&
    now() - lastActivity < SESSION_ACTIVITY_WINDOW_MS;
  async function check() {
    if (
      !eligible() ||
      inFlight ||
      now() - lastCheck < SESSION_CHECK_INTERVAL_MS
    )
      return;
    lastCheck = now();
    inFlight = true;
    try {
      const { session } = await transport.status();
      if (!eligible() || session.userId !== ownerId) return;
      if (Date.parse(session.serverTime) >= Date.parse(session.renewAfter)) {
        await transport.renew({ userId: ownerId, scopeId: session.scopeId });
      }
    } catch (error) {
      if (!disposed && stillCurrent()) onSessionDenial(error);
    } finally {
      inFlight = false;
    }
  }
  return {
    activity(trusted: boolean) {
      if (!trusted || disposed) return;
      lastActivity = now();
      void check();
    },
    check,
    dispose() {
      disposed = true;
    },
  };
}

export function useSessionRenewal(ownerId: string | null) {
  useEffect(() => {
    if (!ownerId) return;
    const epoch = identityContextEpoch();
    const controller = createSessionRenewalController(
      ownerId,
      {
        status: () => api('/auth/session', {}, webSessionStatusSchema),
        renew: (body) =>
          api(
            '/auth/session/renew',
            { method: 'POST', body },
            renewWebSessionResultSchema,
          ),
      },
      {
        stillCurrent: () =>
          identityContextEpoch() === epoch &&
          currentIdentityOwner() === ownerId,
      },
    );
    const activity = (event: Event) => controller.activity(event.isTrusted);
    const visible = () => void controller.check();
    for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(name, activity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(
      () => void controller.check(),
      SESSION_CHECK_INTERVAL_MS,
    );
    return () => {
      controller.dispose();
      window.clearInterval(interval);
      for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
        window.removeEventListener(name, activity, true);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [ownerId]);
}

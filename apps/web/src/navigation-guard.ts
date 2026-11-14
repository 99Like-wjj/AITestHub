let blocker: ((proceed: () => void) => void) | null = null;

export function registerNavigationBlocker(next: (proceed: () => void) => void) {
  blocker = next;
  return () => {
    if (blocker === next) blocker = null;
  };
}

export function requestNavigation(proceed: () => void) {
  if (blocker) blocker(proceed);
  else proceed();
}

export const hasNavigationBlocker = () => blocker !== null;

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type ToastTone = 'default' | 'success';

export type ToastOptions = {
  tone?: ToastTone;
  durationMs?: number;
};

type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
};

type ToastContextValue = {
  showToast: (message: string, options?: ToastOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function useStableId(prefix = 'toast') {
  const ref = useRef(0);
  return useCallback(() => {
    ref.current += 1;
    return `${prefix}-${Date.now()}-${ref.current}`;
  }, [prefix]);
}

function ToastViewport({
  toast,
  onDone
}: {
  toast: ToastItem;
  onDone: () => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let cancelled = false;
    let exitTimer: number | null = null;
    let doneTimer: number | null = null;

    const enterDuration = 240;
    const exitDuration = 320;
    const hold = Math.max(0, toast.durationMs);

    // Start hidden, then animate down into view.
    el.classList.remove('is-visible', 'is-exiting');
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    el.offsetHeight; // force reflow so repeated toasts re-animate
    requestAnimationFrame(() => {
      if (cancelled) return;
      el.classList.add('is-visible');
    });

    exitTimer = window.setTimeout(() => {
      if (cancelled) return;
      el.classList.add('is-exiting');
    }, enterDuration + hold);

    doneTimer = window.setTimeout(() => {
      if (cancelled) return;
      onDone();
    }, enterDuration + hold + exitDuration + 20);

    return () => {
      cancelled = true;
      if (exitTimer) window.clearTimeout(exitTimer);
      if (doneTimer) window.clearTimeout(doneTimer);
    };
  }, [toast.id, toast.durationMs, onDone]);

  return (
    <div className="app-toast-viewport" aria-live="polite" aria-atomic="true">
      <div
        ref={elRef}
        className={`app-toast tone-${toast.tone}`}
        role="status"
      >
        <span className="app-toast-dot" aria-hidden />
        <span className="app-toast-message">{toast.message}</span>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const nextId = useStableId();
  const [queue, setQueue] = useState<ToastItem[]>([]);

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const tone = options.tone ?? 'default';
      const durationMs = options.durationMs ?? 1000;
      const item: ToastItem = {
        id: nextId(),
        message,
        tone,
        durationMs
      };
      setQueue((prev) => [...prev, item]);
    },
    [nextId]
  );

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  const active = queue[0] ?? null;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {active ? (
        <ToastViewport
          toast={active}
          onDone={() => setQueue((prev) => prev.slice(1))}
        />
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within <ToastProvider />');
  }
  return ctx;
}


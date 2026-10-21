import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeDB } from './db';

/** DBの変更に追従して再読み込みする。 */
export function useLive<T>(loader: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    const run = () => {
      loader()
        .then((v) => alive && setValue(v))
        .catch(() => undefined);
    };
    run();
    const off = subscribeDB(run);
    return () => {
      alive = false;
      off();
    };
  }, deps);
  return value;
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}
export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

export function useOnline(): boolean {
  const [on, setOn] = useState(() => navigator.onLine);
  useEffect(() => {
    const u = () => setOn(true);
    const d = () => setOn(false);
    window.addEventListener('online', u);
    window.addEventListener('offline', d);
    return () => {
      window.removeEventListener('online', u);
      window.removeEventListener('offline', d);
    };
  }, []);
  return on;
}

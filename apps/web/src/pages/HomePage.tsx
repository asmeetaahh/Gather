import { useEffect, useState } from 'react';
import { fetchHealth } from '../api/health';
import { CharitySpotlight } from './CharitySpotlight';

type ApiStatus = 'checking' | 'online' | 'offline';

/**
 * Phase 0 placeholder home. It only proves that the web app builds, runs and can reach the API through
 * the shared contract. The real marketing homepage is designed in a later phase.
 */
export function HomePage() {
  const [status, setStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then(() => {
        setStatus('online');
      })
      .catch(() => {
        // An aborted request means the component unmounted; do not touch state in that case.
        if (!controller.signal.aborted) setStatus('offline');
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <section>
      <h1>GATHER</h1>
      <p>Foundation shell. The product UI is not built yet.</p>
      <p role="status" data-status={status}>
        API status: {status}
      </p>
      <CharitySpotlight />
    </section>
  );
}

import { AuthProvider } from './auth/AuthProvider';
import type { AuthClient } from './auth/types';
import { AppRoutes } from './AppRoutes';

/** The application. The router is supplied by `main.tsx` (BrowserRouter) or by tests (MemoryRouter). */
export function App({ client }: { client: AuthClient | null }) {
  return (
    <AuthProvider client={client}>
      <AppRoutes />
    </AuthProvider>
  );
}

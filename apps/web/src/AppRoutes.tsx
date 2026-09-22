import { Route, Routes } from 'react-router-dom';
import { GuestOnly, RequireAdmin, RequireAuth } from './auth/guards';
import { AccountPage } from './pages/AccountPage';
import { AdminPage } from './pages/AdminPage';
import { CharitiesPage } from './pages/CharitiesPage';
import { CharityDetailPage } from './pages/CharityDetailPage';
import { CharityPreferencePage } from './pages/CharityPreferencePage';
import { HomePage } from './pages/HomePage';
import { Layout } from './pages/Layout';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { SignupPage } from './pages/SignupPage';

/** Route table. Guards are UX only — the API enforces authentication and authorization (D-005). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="charities" element={<CharitiesPage />} />
        <Route path="charities/:slug" element={<CharityDetailPage />} />

        <Route element={<GuestOnly />}>
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route path="account" element={<AccountPage />} />
          <Route path="account/charity" element={<CharityPreferencePage />} />
          <Route path="account/subscription" element={<SubscriptionPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="admin" element={<AdminPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

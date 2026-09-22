import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { createBrowserSupabase } from './lib/supabase';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found in index.html');

// Null when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing: the app then shows an
// "authentication unavailable" notice instead of crashing.
const supabase = createBrowserSupabase({
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App client={supabase} />
    </BrowserRouter>
  </StrictMode>,
);

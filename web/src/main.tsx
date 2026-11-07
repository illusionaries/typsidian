import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import App from './App';
import { store } from './store';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

// Dev-only handle used by the headless verification scripts and manual poking.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__typsidian = { store };
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

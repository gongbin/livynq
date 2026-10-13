import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope/wght.css';
import './styles.css';
import './lib/prefs.ts';
import { App } from './app.tsx';
import { registerServiceWorker } from './lib/push.ts';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

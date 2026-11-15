// Mounted only by dev/mode-chats-harness.mjs in a Vite dev server. It is not part of the app
// bundle: no production entry imports it. It mounts the real App so the mode marker, the Chat
// button, focus handling and the responsive drawer are exercised as shipped, not as mocked markup.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { installSafeStorage } from '../src/storage';
import '../src/styles.css';
// Same order as src/main.tsx, including the slice-2 sheet.
import '../src/theme/pass1-composition.css';
import '../src/theme/pass2-type.css';
import '../src/theme/pass3-surface.css';
import '../src/theme/pass4-motion.css';
import '../src/theme/pass4-states.css';
import '../src/theme/pass5-micro.css';
import '../src/theme/pass6-read-expand.css';
import '../src/theme/pass8-console.css';
import '../src/theme/pass9-nous.css';
import '../src/theme/pass10-bridge.css';
import '../src/theme/tokens.css';
import '../src/theme/pass10-paper.gen.css';
import '../src/theme/pass11-modes.css';
import '../src/theme/pass12-premium.css';
import '../src/theme/audit-overflow-fixes.css';

installSafeStorage();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

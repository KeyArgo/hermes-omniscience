// Mounted only by dev/premium-harness.mjs in a Vite dev server. Not part of the app bundle.
//
// The real App against a synthetic recording (dev/premium-mock.ts): every session, event, chart
// point and replay stop below is generated in the page. No viewer, database or network is
// involved, and nothing here ships.
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { installSafeStorage } from '../src/storage';
import { installShowcaseViewer } from './premium-mock';
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
import '../src/theme/focus-areas.css';

installSafeStorage();
installShowcaseViewer();

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

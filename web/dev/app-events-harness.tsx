// Mounted only by dev/app-events-harness.mjs in a Vite dev server. Not part of the app bundle: no
// production entry imports it.
//
// It installs the synthetic viewer *before* mounting the real App, so the App's own endpoints,
// effects and state machine are exercised as shipped — the load-earlier window, a failed page, a
// chat switch while a page is in flight — against fixture rows instead of someone's recording.
// No StrictMode: its development-only double effect would run each scenario twice and make request
// counts meaningless. The shipped build runs the effects once, which is what these checks measure.
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { installSafeStorage } from '../src/storage';
import { installSyntheticViewer } from './app-events-mock';
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
installSyntheticViewer();

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

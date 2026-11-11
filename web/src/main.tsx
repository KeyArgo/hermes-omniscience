import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
// Black Box design passes: loaded last so each layer overrides only what it owns.
import './theme/pass1-composition.css';
import './theme/pass2-type.css';
import './theme/pass3-surface.css';
import './theme/pass4-motion.css';
import './theme/pass4-states.css';
import './theme/pass5-micro.css';
import './theme/pass6-read-expand.css';
import './theme/pass8-console.css';
import './theme/pass9-nous.css';
import './theme/pass10-bridge.css';
import './theme/tokens.css';
import './theme/pass10-paper.gen.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

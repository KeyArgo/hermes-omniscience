// Writes docs/UI-GUIDE.md from web/src/help/guide.json: `node web/scripts/gen-ui-guide.mjs`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { renderGuide } from '../src/help/renderGuide.mjs';

const guide = JSON.parse(readFileSync(new URL('../src/help/guide.json', import.meta.url), 'utf8'));
const path = new URL('../../docs/UI-GUIDE.md', import.meta.url);
const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
const stamp = old.match(/^> \*\*Applies to:\*\*.*\n> \*\*Revised:\*\*.*\n/m)?.[0];
const rendered = renderGuide(guide);
writeFileSync(path, stamp ? rendered.replace('\n\n', `\n\n${stamp}\n\n`) : rendered);
console.log('wrote docs/UI-GUIDE.md');

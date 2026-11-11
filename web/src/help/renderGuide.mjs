// Shared by the generator script and the test that keeps docs/UI-GUIDE.md in sync.
export function renderGuide(g) {
  const out = [
    '# Omniscience — a guide to the screen',
    '',
    'Generated from `web/src/help/guide.json` by `web/scripts/gen-ui-guide.mjs`. The same text',
    'feeds the tooltips, so the page and this guide cannot disagree. Edit the JSON, not this file.',
    '',
    'Nothing on the page is ever deleted by a layout choice: a hidden panel stays listed in **Panels**,',
    'one click from coming back, and **Reset view** restores how Omniscience first opens.',
    '',
  ];
  for (const section of g.sections) {
    out.push(`## ${section.title}`, '');
    for (const item of section.items) out.push(`- **${item.name}** — ${item.what}`);
    out.push('');
  }
  out.push('## Keyboard', '',
    '- **Tab / Shift+Tab** — move between controls; every control shows a blue focus ring and its tooltip.',
    '- **Esc** — close a menu, the Panels sheet, a focused panel, the tour or a tooltip.',
    '- **↑ ↓ Home End** — move inside an open menu; on a panel\'s resize bar, change its height.',
    '- **← →** — previous / next stop while the tour is open.',
    '- **1 – 5** — List, Map, Time, Tokens, Usage.',
    '- **[ and ]** — previous / next failure in this chat.',
    '- **B** — open or close the Briefing.',
    '- **P** — open Panels.',
    '- **?** — What Am I Looking At?',
    '',
    'Single-key shortcuts are ignored while you type in a field or hold Ctrl, Cmd or Alt.', '');
  return out.join('\n');
}


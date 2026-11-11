import { describe, expect, it } from 'vitest';
import doc from '../../../docs/UI-GUIDE.md?raw';
import guide from './guide.json';
import { renderGuide } from './renderGuide.mjs';

describe('the screen guide', () => {
  it('docs/UI-GUIDE.md is generated from guide.json and up to date (run web/scripts/gen-ui-guide.mjs)', () => {
    const withoutStamp = doc.replace(/\n\n> \*\*Applies to:\*\*.*\n> \*\*Revised:\*\*.*\n\n\n/, '\n\n');
    expect(withoutStamp).toBe(renderGuide(guide));
  });

  it('every section item has a name and an explanation', () => {
    for (const section of guide.sections) {
      for (const item of section.items) {
        expect(item.name.length).toBeGreaterThan(1);
        expect(item.what.length).toBeGreaterThan(10);
      }
    }
  });
});

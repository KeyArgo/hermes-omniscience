import { describe, expect, it } from 'vitest';
import doc from '../../../docs/UI-GUIDE.md?raw';
import guide from './guide.json';
import { renderGuide } from './renderGuide.mjs';

function withoutStamp(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n\n> \*\*Applies to:\*\*.*\n> \*\*Revised:\*\*.*\n\n\n/, '\n\n');
}

describe('the screen guide', () => {
  it('docs/UI-GUIDE.md is generated from guide.json and up to date (run web/scripts/gen-ui-guide.mjs)', () => {
    expect(withoutStamp(doc)).toBe(renderGuide(guide));
  });

  it('accepts Windows line endings without hiding content changes', () => {
    expect(withoutStamp(doc.replace(/\r?\n/g, '\r\n'))).toBe(renderGuide(guide));
    expect(withoutStamp(doc.replace('The header', 'Changed header'))).not.toBe(renderGuide(guide));
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

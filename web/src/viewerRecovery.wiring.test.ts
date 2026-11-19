import { describe, expect, it } from 'vitest';
import concernsSource from './components/ConcernsView.tsx?raw';
import privacySource from './components/PrivacyView.tsx?raw';
import usageSource from './components/UsageView.tsx?raw';
import appSource from './App.tsx?raw';
import apiSource from './api.ts?raw';

// The recovery wiring, pinned at its call sites the way tests/test_desktop_plugin.py pins the
// desktop page: the defect this lane fixes IS a missing call, and a mocked DOM would pass with
// the call absent. The behaviour of the shared helper itself is tested in shell/viewerSignal.test.ts
// and api.test.ts; this file pins that every failure path and every Retry button actually uses it.

describe('the views report a stopped viewer and offer a Retry that reports it too', () => {
  const views: [string, string][] = [
    [concernsSource, 'could not read the recording'],
    [privacySource, 'could not read the record'],
    [usageSource, 'could not read usage'],
  ];

  for (const [source, fallback] of views) {
    it(`reads a transport failure as the stopped-viewer sentence, not raw Failed to fetch (${fallback})`, () => {
      expect(source).toContain('viewerReadFailure(');
      expect(source).toContain(`'${fallback}'`);
      // The old raw-message path must be gone: it showed "Failed to fetch" to the owner.
      expect(source).not.toMatch(/setError\((failure|exc) instanceof Error \? \1\.message/);
    });

    it(`Retry asks the host to bring the viewer back before reloading (${fallback})`, () => {
      const retries = source.match(/onClick=\{\(\) => \{ notifyViewerUnreachable\(\);/g) ?? [];
      // Concerns/Privacy have one Retry; Usage has "Try again" and "refresh".
      expect(retries.length).toBeGreaterThanOrEqual(1);
      expect(source).toContain("import { notifyViewerUnreachable, viewerReadFailure } from '../shell/viewerSignal'");
    });
  }
});

describe('the live socket and the shared reader report a stopped viewer', () => {
  it('App.tsx tells the host when the socket closes while somebody is looking', () => {
    expect(appSource).toContain("import { notifyViewerUnreachable } from './shell/viewerSignal'");
    // The report sits after the paused/hidden guard, so a close we asked for is not a failure.
    const onclose = appSource.slice(appSource.indexOf('live.onclose'), appSource.indexOf('live.onerror'));
    expect(onclose).toContain('if (paused || !pageVisible()) return;');
    expect(onclose.indexOf('notifyViewerUnreachable()')).toBeGreaterThan(onclose.indexOf('if (paused || !pageVisible()) return;'));
  });

  it('api.ts getJson reports a transport rejection before rethrowing it', () => {
    const getJson = apiSource.slice(apiSource.indexOf('async function getJson'), apiSource.indexOf('function arrayFrom'));
    expect(getJson).toContain('isViewerUnreachableError(error)');
    expect(getJson).toContain('notifyViewerUnreachable()');
    expect(getJson).toContain('throw error');
  });

  it('the offline banner points at the reset that exists, not at quitting Hermes', () => {
    expect(appSource).toContain('Restart viewer</strong> in');
    expect(appSource).not.toContain('restart the Hermes gateway');
  });
});

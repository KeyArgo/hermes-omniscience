import { describe, expect, it } from 'vitest';
import { riskOf, strongest } from './risk';

describe('riskOf', () => {
  it('flags browser and computer use loudly', () => {
    expect(riskOf('browser_exec')).toEqual({ cls: 'browser', label: 'Browser use', tone: 'high' });
    expect(riskOf('computer_use')?.cls).toBe('computer');
    expect(riskOf('Screenshot')?.cls).toBe('computer');
  });

  it('flags a sweep only when it searched more than five files', () => {
    expect(riskOf('grep', { files: 12 })).toEqual({
      cls: 'grep-broad',
      label: 'Wide file sweep',
      tone: 'high',
    });
    expect(riskOf('search_files', { paths: ['a', 'b', 'c', 'd', 'e', 'f'] })?.cls).toBe('grep-broad');
    // Five or fewer is a read of a few things, not a sweep of the disk.
    expect(riskOf('grep', { files: 5 })).toBeNull();
    expect(riskOf('grep', { paths: ['a', 'b'] })).toBeNull();
    expect(riskOf('grep')).toBeNull();
  });

  it('mentions network and MCP quietly', () => {
    expect(riskOf('web_search')).toEqual({ cls: 'network', label: 'Network call', tone: 'low' });
    expect(riskOf('mcp__filesystem__read_file')).toEqual({
      cls: 'mcp',
      label: 'MCP server',
      tone: 'low',
    });
  });

  it('says nothing about ordinary tools', () => {
    for (const name of ['terminal', 'read_file', 'write_file', 'todo_list', 'delegate_task']) {
      expect(riskOf(name)).toBeNull();
    }
  });

  it('puts the loudest hit first', () => {
    const low = riskOf('web_search')!;
    const high = riskOf('browser_exec')!;
    expect(strongest([low, high])).toBe(high);
    expect(strongest([low])).toBe(low);
    expect(strongest([])).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatRow } from './UsageView';
import type { UsageChat } from '../types';

const chat: UsageChat = {
  id: 'abcdef0123456789abcdef',
  calls: 12,
  prompt: 120000,
  prompt_now: 9000,
  prompt_max: 240000,
  cache_read: 5000,
  output: 800,
  tools: 7,
  first_ts: 1762400000,
  last_ts: 1762403600,
  p95_s: 12,
  cost: 0.42,
};

const noop = () => {};

const renderRow = () =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <ChatRow chat={chat} onOpenChat={noop} />
      </tbody>
    </table>,
  );

/** The props ChatRow actually renders, so the real handlers can be exercised. */
function rowProps(onOpenChat: (sessionId: string) => void = noop) {
  const element = ChatRow({ chat, onOpenChat });
  return element.props as {
    onClick: () => void;
    onKeyDown?: unknown;
    tabIndex?: number;
    'aria-label'?: string;
    children: Array<{ props: { children?: unknown } }>;
  };
}

function buttonProps(onOpenChat: (sessionId: string) => void = noop) {
  const button = rowProps(onOpenChat).children[0].props.children as {
    props: {
      type?: string;
      tabIndex?: number;
      'aria-label'?: string;
      onClick: (e: { stopPropagation: () => void }) => void;
      onKeyDown: (e: Record<string, unknown>) => void;
    };
  };
  return button.props;
}

describe('UsageView chat rows', () => {
  it('keeps the row a plain table row: the button is the only keyboard stop', () => {
    const tag = renderRow().match(/<tr[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('class="us-chatrow"');
    // No focusable, renamed row: the cells keep their own reading, and the button names itself.
    expect(tag).not.toContain('tabindex');
    expect(tag).not.toContain('aria-label');
    expect(tag).not.toContain('role=');
  });

  it('puts exactly one real button in the first cell', () => {
    const html = renderRow();
    expect(html.match(/<button/g)).toHaveLength(1);
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain(`aria-label="Open chat ${chat.id}"`);
    expect(button).not.toContain('tabindex');
    // The visible label is the same truncated id as before.
    expect(html).toContain('>abcdef0123456789ab…</button>');
    // It is in the first cell, before any other cell.
    expect(html.indexOf('<button')).toBeGreaterThan(html.indexOf('<tr'));
    expect(html.indexOf('<button')).toBeLessThan(html.indexOf('</td>'));
  });

  it('keeps the cells it renders today', () => {
    const html = renderRow();
    expect(html).toContain('12');
    expect(html).toContain('7');
    expect(html.match(/<td/g)).toHaveLength(8);
  });
});

describe('UsageView chat row handlers', () => {
  it('opens the chat from the row, for the mouse', () => {
    const opened = vi.fn();
    rowProps(opened).onClick();
    expect(opened).toHaveBeenCalledWith(chat.id);
    // The row is not a keyboard target of its own.
    expect(rowProps(opened).tabIndex).toBeUndefined();
    expect(rowProps(opened).onKeyDown).toBeUndefined();
  });

  it('opens the chat once from the button, stopping the row click from repeating it', () => {
    const opened = vi.fn();
    const stopPropagation = vi.fn();

    buttonProps(opened).onClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(chat.id);
  });

  it('leaves plain Enter and Space to the native button', () => {
    const preventDefault = vi.fn();
    const keyDown = buttonProps().onKeyDown;

    keyDown({ key: 'Enter', preventDefault });
    keyDown({ key: ' ', preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('suppresses the native click for held and modified keys', () => {
    const preventDefault = vi.fn();
    const keyDown = buttonProps().onKeyDown;

    keyDown({ key: 'Enter', repeat: true, preventDefault });
    keyDown({ key: ' ', repeat: true, preventDefault });
    keyDown({ key: 'Enter', ctrlKey: true, preventDefault });
    keyDown({ key: 'Enter', metaKey: true, preventDefault });
    keyDown({ key: ' ', altKey: true, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(5);
  });

  it('ignores keys it does not activate', () => {
    const preventDefault = vi.fn();
    const keyDown = buttonProps().onKeyDown;

    keyDown({ key: 'Tab', repeat: true, preventDefault });
    keyDown({ key: 'a', ctrlKey: true, preventDefault });
    keyDown({ key: 'Escape', preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});

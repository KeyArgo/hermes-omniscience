import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatsButton } from './ChatsButton';

describe('ChatsButton', () => {
  it('names the control and states whether the list is open', () => {
    const closed = renderToStaticMarkup(
      <ChatsButton open={false} count={4} onToggle={() => {}} />,
    );
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="chats-panel"');
    expect(closed).toContain('Chats');
    expect(closed).toContain('▸');

    const open = renderToStaticMarkup(<ChatsButton open count={4} onToggle={() => {}} />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('is-open');
    expect(open).toContain('▾');
  });

  it('carries the count, and the singular label for one chat', () => {
    expect(
      renderToStaticMarkup(<ChatsButton open={false} count={1} onToggle={() => {}} />),
    ).toContain('aria-label="Chats, 1 recorded chat"');
    const many = renderToStaticMarkup(<ChatsButton open={false} count={1234} onToggle={() => {}} />);
    const formatted = (1234).toLocaleString();
    expect(many).toContain(`aria-label="Chats, ${formatted} recorded chats"`);
    expect(many).toContain(formatted);
  });

  it('does not claim zero chats while the list is loading', () => {
    const loading = renderToStaticMarkup(
      <ChatsButton open={false} count={null} onToggle={() => {}} />,
    );
    expect(loading).toContain('aria-label="Chats"');
    expect(loading).not.toContain('chats-toggle-count');
  });
});

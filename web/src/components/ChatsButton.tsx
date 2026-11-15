import type { Ref } from 'react';

/**
 * The one Chats control. It is in the header at every width, carries the count, and says whether
 * the list is open (`aria-expanded`) instead of making the reader infer it from the layout. It
 * drives the list column on a wide window and the drawer on a narrow one; App decides which.
 */
export function ChatsButton({
  open,
  count,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  /** Recorded chats, or null while the list is still loading (no misleading 0). */
  count: number | null;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const countText = count === null ? null : count.toLocaleString();
  const label =
    countText === null
      ? 'Chats'
      : `Chats, ${countText} recorded chat${count === 1 ? '' : 's'}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`chats-toggle${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-controls="chats-panel"
      aria-label={label}
      onClick={onToggle}
      title={
        open
          ? 'Chats: hide the list of recorded chats.'
          : 'Chats: show every recorded chat and pick the one to follow.'
      }
    >
      <span className="chats-toggle-glyph" aria-hidden="true">
        ☰
      </span>
      <span className="chats-toggle-text">Chats</span>
      {countText ? (
        <span className="chats-toggle-count mono" aria-hidden="true">
          {countText}
        </span>
      ) : null}
      <span className="chats-toggle-caret" aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
    </button>
  );
}

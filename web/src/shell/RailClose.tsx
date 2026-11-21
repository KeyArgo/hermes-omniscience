/**
 * The one × on the right-hand rail.
 *
 * The rail shows four different things — the Inspector (Inspect tab), the Warnings list, the Why
 * panel and the mini panel (`railMode: 'follow'`) — and only the Inspector used to carry a close
 * button, so closing the panel from any other tab meant Escape or empty map space. At 701–900 px
 * the rail's collapse chevron is hidden as well, which left the drawer with no way out at all.
 *
 * This control is drawn once, outside those branches, so the same "Close details" button is in
 * the same place whatever the rail is showing, and it is the only one (the Inspector no longer
 * paints a second).
 */
export function RailClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="rail-close"
      onClick={onClose}
      title="Close details (Esc)"
      aria-label="Close details"
    >
      ×
    </button>
  );
}

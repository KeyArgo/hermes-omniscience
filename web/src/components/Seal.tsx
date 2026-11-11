/**
 * The seal: a winged eye inside a double ring.
 *
 * Gold outer ring is the Nous mark; the blue inner ring is observation; the eye is off-white with
 * a blue pupil and one highlight. Drawn in one viewBox so it reads at 16 px (favicon) and 128 px
 * (a slide) without a second asset.
 */
export function Seal({ size = 30, title = "Omniscience" }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title} fill="none">
      <circle cx="32" cy="32" r="30" stroke="#d9b876" strokeOpacity=".55" strokeWidth="1" />
      <circle cx="32" cy="32" r="25.5" stroke="#3d7bff" strokeOpacity=".55" strokeWidth="1" />
      <path
        d="M32 20c7.5 0 13 5.4 15.5 12-2.5 6.6-8 12-15.5 12S24 38.6 21.5 32C24 25.4 29.5 20 32 20Z"
        stroke="#f5f2ea"
        strokeOpacity=".85"
        strokeWidth="1.3"
      />
      <circle cx="32" cy="32" r="4.6" fill="#3d7bff" />
      <circle cx="33.6" cy="30.4" r="1.3" fill="#f5f2ea" fillOpacity=".9" />
      <path
        d="M17 24c-4 1.2-7 3.6-8.6 6.9M47 24c4 1.2 7 3.6 8.6 6.9"
        stroke="#d9b876"
        strokeOpacity=".5"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

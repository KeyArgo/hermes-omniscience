/**
 * Whether the context chart should use a logarithmic axis.
 *
 * A linear axis is set by the peak, so one enormous first call flattens everything after it into a
 * line along the floor. The peak is compared with the median call and with the last call: either
 * comparison catching a big spread is enough, and every tick stays labelled on a log axis.
 */
export function shouldLogScale(peak: number, median: number, last: number | null): boolean {
  if (!(peak > 0)) return false;
  if (median > 0 && peak / median > 3) return true;
  return last != null && last > 0 && peak / last > 4;
}

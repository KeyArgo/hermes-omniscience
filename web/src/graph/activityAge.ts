export function activityAge(timestampSeconds: number | null, nowSeconds: number): string {
  if (timestampSeconds === null || !Number.isFinite(timestampSeconds) || !Number.isFinite(nowSeconds)) return 'Unknown';
  const age = Math.max(0, nowSeconds - timestampSeconds);
  if (age < 60) return 'Just now';
  if (age < 3600) {
    const minutes = Math.floor(age / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (age < 86400) {
    const hours = Math.floor(age / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(age / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

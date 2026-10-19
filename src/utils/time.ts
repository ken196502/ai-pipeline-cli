export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  if (h > 0) {
    const remM = m % 60;
    return `${h}:${remM.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function roundSeconds(sec: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(sec * factor) / factor;
}

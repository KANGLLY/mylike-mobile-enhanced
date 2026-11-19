// In-memory + persisted ring-buffer logger for Douyin library sync diagnostics.
// Pure module (no React Native dependencies) so it can be unit-tested cleanly.

const MAX_LINES = 150;
const lines: string[] = [];
const listeners = new Set<() => void>();

function stamp(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function clearSyncLog(): void {
  lines.length = 0;
  for (const fn of listeners) fn();
}

export function hydrateSyncLog(raw: string | null): void {
  if (!raw || lines.length > 0) return;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed.trim()) {
      lines.push(...parsed.split('\n').slice(-MAX_LINES));
      for (const fn of listeners) fn();
    }
  } catch {
    if (raw.trim()) {
      lines.push(...raw.split('\n').slice(-MAX_LINES));
      for (const fn of listeners) fn();
    }
  }
}

export function appendSyncLog(message: string): void {
  const entry = `[${stamp()}] ${message}`;
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  for (const fn of listeners) fn();
}

export function readSyncLogText(): string {
  return lines.join('\n');
}

export function readSyncLogLines(): readonly string[] {
  return lines.slice();
}

export function subscribeSyncLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function sanitizeBodyPreview(body: string, limit = 160): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, limit).trim();
}

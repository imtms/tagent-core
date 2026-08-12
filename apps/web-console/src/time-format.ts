const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const exactFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function formatTime(value: number): string {
  return timeFormatter.format(value);
}

export function formatExactDateTime(value: number): string {
  return exactFormatter.format(value);
}

export function formatRelativeTime(value: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - value) / 1_000));
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function localDayKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatConversationDay(value: number, now = Date.now()): string {
  const today = localDayKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = localDayKey(value);
  if (day === today) return "Today";
  if (day === localDayKey(yesterday.getTime())) return "Yesterday";
  return dayFormatter.format(value);
}

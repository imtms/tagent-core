import { useEffect, useState } from "react";
import { formatExactDateTime, formatRelativeTime } from "./time-format";

const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  if (!ticker) ticker = setInterval(() => { for (const subscriber of subscribers) subscriber(); }, 30_000);
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size && ticker) { clearInterval(ticker); ticker = undefined; }
  };
}

export function TimeAgo({ value, className }: { value: number; className?: string }) {
  const [, refresh] = useState(0);
  useEffect(() => subscribe(() => refresh((current) => current + 1)), []);
  return <time className={className} dateTime={new Date(value).toISOString()} title={formatExactDateTime(value)}>{formatRelativeTime(value)}</time>;
}

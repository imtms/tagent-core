import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, Copy, X } from "lucide-react";
import type { CaptureJob, Message } from "./api";
import { ICON_SIZE } from "./icon-size";
import { Markdown } from "./LazyMarkdown";
import { LiveText } from "./LiveText";
import { TimeAgo } from "./TimeAgo";
import { formatCount } from "./count-format";

function MemoryExtraction({ job }: { job?: CaptureJob | null }) {
  if (!job || job.status === "completed_empty") return null;
  const completed = job.status === "completed";
  const failed = job.status === "dead_letter" || job.status === "retryable_failed";
  const count = job.persistedCount ?? 0;
  if (completed && count <= 0) return null;
  const detail = completed
    ? `${formatCount(count, "memory", "memories")} extracted`
    : failed ? `Extraction failed${job.errorCode ? ` · ${job.errorCode}` : ""}`
    : job.status === "running" ? "Extracting durable memory…" : "Queued for extraction";
  const tone = completed ? "success" : failed ? "danger" : job.status === "running" ? "info" : undefined;
  return <div className="turn-memory" data-tone={tone} title={`Memory extraction · capture job ${job.id}`}><BrainCircuit size={ICON_SIZE.xs} /><span>{detail}</span></div>;
}

function copyTextWithSelection(content: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  document.body.append(textarea);
  textarea.select();
  let copied: boolean;
  try { copied = typeof document.execCommand === "function" && document.execCommand("copy"); }
  catch { copied = false; }
  finally { textarea.remove(); active?.focus(); }
  return copied;
}

async function copyText(content: string): Promise<boolean> {
  // Keep the synchronous fallback inside the click's user-activation window.
  // Local control planes and embedded browsers may deny the asynchronous API.
  if (copyTextWithSelection(content)) return true;
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(content);
    return true;
  } catch { return false; }
}

function MessageCopy({ content }: { content: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);
  const copy = useCallback(async () => {
    setState(await copyText(content) ? "copied" : "failed");
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setState("idle"), 1_200);
  }, [content]);
  const copied = state === "copied";
  const failed = state === "failed";
  return <button className="message-copy" data-tone={failed ? "danger" : undefined} type="button" onClick={() => void copy()} aria-label={copied ? "Message copied" : failed ? "Copy unavailable" : "Copy message"} title={copied ? "Copied" : failed ? "Clipboard unavailable" : "Copy message"}>{copied ? <Check size={ICON_SIZE.xs} /> : failed ? <X size={ICON_SIZE.xs} /> : <Copy size={ICON_SIZE.xs} />}<span>{copied ? "Copied" : failed ? "Unavailable" : "Copy"}</span></button>;
}

function MessageFooter({ createdAt, content, pending = false }: { createdAt?: number; content?: string; pending?: boolean }) {
  return <footer className="message-footer">{pending ? <span>Sending…</span> : createdAt !== undefined && <TimeAgo value={createdAt} />}{content && !pending && <MessageCopy content={content} />}</footer>;
}

export const ConversationMessage = memo(function ConversationMessage({ message, memoryJob }: { message: Message; memoryJob?: CaptureJob | null }) {
  const speaker = message.role === "user" ? "You" : "TAgent";
  return <article className="message" data-role={message.role} aria-label={`Message from ${speaker}`}><div className="message-body"><Markdown>{message.content}</Markdown></div><MessageFooter createdAt={message.createdAt} content={message.content} />{message.role === "user" && <MemoryExtraction job={memoryJob} />}</article>;
});

export function PendingConversationMessage({ content }: { content: string }) {
  return <article className="message" data-role="user" aria-label="Sending message"><div className="message-body"><LiveText>{content}</LiveText></div><MessageFooter pending /></article>;
}

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, Copy, X } from "lucide-react";
import type { CaptureJob, Message } from "./api";
import { Markdown } from "./LazyMarkdown";
import { LiveText } from "./LiveText";
import { TimeAgo } from "./TimeAgo";

function MemoryExtraction({ job }: { job: CaptureJob | null | undefined }) {
  if (job === undefined) return <div className="turn-memory loading"><BrainCircuit size={11} /><span>Checking memory…</span></div>;
  if (!job) return <div className="turn-memory empty"><BrainCircuit size={11} /><span>No durable memory</span></div>;
  const completed = job.status === "completed";
  const empty = job.status === "completed_empty";
  const failed = job.status === "dead_letter" || job.status === "retryable_failed";
  const count = job.persistedCount ?? job.proposalCount ?? 0;
  const detail = completed
    ? `${count} ${count === 1 ? "memory" : "memories"} extracted`
    : empty ? "No durable memory extracted"
    : failed ? `Extraction failed${job.errorCode ? ` · ${job.errorCode}` : ""}`
    : job.status === "running" ? "Extracting durable memory…" : "Queued for extraction";
  return <div className={`turn-memory ${completed ? "completed" : empty ? "empty" : failed ? "failed" : job.status}`} title={`Memory extraction · capture job ${job.id}`}><BrainCircuit size={11} /><span>{detail}</span></div>;
}

function legacyCopyText(content: string): boolean {
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
  if (legacyCopyText(content)) return true;
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
  return <button className={`message-copy ${state}`} type="button" onClick={() => void copy()} aria-label={copied ? "Message copied" : failed ? "Copy unavailable" : "Copy message"} title={copied ? "Copied" : failed ? "Clipboard unavailable" : "Copy message"}>{copied ? <Check size={11} /> : failed ? <X size={11} /> : <Copy size={11} />}<span>{copied ? "Copied" : failed ? "Unavailable" : "Copy"}</span></button>;
}

function MessageFooter({ createdAt, content, pending = false }: { createdAt?: number; content?: string; pending?: boolean }) {
  return <footer className="message-footer">{pending ? <span>Sending…</span> : createdAt !== undefined && <TimeAgo value={createdAt} />}{content && !pending && <MessageCopy content={content} />}</footer>;
}

export const ConversationMessage = memo(function ConversationMessage({ message, memoryEnabled, memoryJob }: { message: Message; memoryEnabled: boolean; memoryJob?: CaptureJob | null }) {
  const speaker = message.role === "user" ? "You" : "TAgent";
  return <article className={`message ${message.role}`} aria-label={`Message from ${speaker}`}><div className="message-body"><Markdown>{message.content}</Markdown></div><MessageFooter createdAt={message.createdAt} content={message.content} />{memoryEnabled && message.role === "user" && <MemoryExtraction job={memoryJob} />}</article>;
});

export function PendingConversationMessage({ content, memoryEnabled }: { content: string; memoryEnabled: boolean }) {
  return <article className="message user pending" aria-label="Sending message"><div className="message-body"><LiveText>{content}</LiveText></div><MessageFooter pending />{memoryEnabled && <MemoryExtraction job={undefined} />}</article>;
}

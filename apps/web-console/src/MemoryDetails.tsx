import { useEffect, useState } from "react";
import { Check, ChevronRight, Pencil, RotateCcw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { ColdTopic, PreferenceRecord, WarmMemory } from "./api";
import { ICON_SIZE } from "./icon-size";
import { Markdown } from "./LazyMarkdown";
import { formatMemoryDate, memoryContent, memorySignal, memoryTitle } from "./memory-display";

export function RecordDetail({
  record,
  onForget,
  onRestore,
  onGovern,
  onCorrect,
  onFeedback,
}: {
  record: WarmMemory;
  onForget: () => void;
  onRestore: () => void;
  onGovern: (action: "approve" | "reject" | "resolve", resolution?: "accept" | "reject") => void;
  onCorrect: (title: string, content: string, reason: string) => void;
  onFeedback: (signal: "helpful" | "harmful") => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [title, setTitle] = useState(memoryTitle(record));
  const [content, setContent] = useState(memoryContent(record));
  const [reason, setReason] = useState("");
  useEffect(() => {
    setCorrecting(false);
    setTitle(memoryTitle(record));
    setContent(memoryContent(record));
    setReason("");
  }, [record.id, record.updatedAt]);
  const canSaveCorrection = content.trim() && (record.kind === "preference" || title.trim());

  return (
    <div className="memory-detail-content">
      <span className="memory-kind">{record.kind}</span>
      <h3>{memoryTitle(record)}</h3>
      <div className="memory-detail-body">
        <Markdown>{memoryContent(record)}</Markdown>
      </div>
      <small data-mono>{record.tier} · {record.status} · {Math.round(record.confidence * 100)}% confidence · {Math.round(memorySignal(record) * 100)}% {record.kind === "preference" ? "strength" : "importance"}</small>
      {record.summary && record.summary !== memoryContent(record) && (
        <section>
          <span>Summary</span>
          <p>{record.summary}</p>
        </section>
      )}
      {record.kind === "preference" && (
        <section>
          <span>Preference semantics</span>
          <p>{(record as PreferenceRecord).applicability} · {(record as PreferenceRecord).origin}</p>
        </section>
      )}
      {record.topicIds.length > 0 && <section>
        <span>Topic routes</span>
        <div className="memory-tags">
          {record.topicIds.map((topic) => <code key={topic}>{topic}</code>)}
        </div>
      </section>}
      {record.sourceRefs.length > 0 && <section>
        <span>Provenance</span>
        <div className="memory-source-list">
          {record.sourceRefs.map((source, index) => (
            <code key={`${source.sourceType}-${source.sourceId}-${index}`}>{source.sourceType}:{source.sourceId}</code>
          ))}
        </div>
      </section>}
      <details className="memory-disclosure">
        <summary><strong>Memory controls</strong><small>Review, correct or forget</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="memory-disclosure-body">
          <div className="memory-inline-actions">
          {record.status === "candidate" && <><button className="control" onClick={() => onGovern("approve")}><Check size={ICON_SIZE.sm} />Approve</button><button className="control" onClick={() => onGovern("reject")}>Reject</button></>}
          {record.status === "disputed" && <><button className="control" onClick={() => onGovern("resolve", "accept")}><Check size={ICON_SIZE.sm} />Resolve as valid</button><button className="control" onClick={() => onGovern("resolve", "reject")}>Quarantine</button></>}
          {!["active", "candidate", "disputed", "deleted"].includes(record.status) && <button className="control" onClick={() => onGovern("approve")}><Check size={ICON_SIZE.sm} />Reactivate</button>}
          {record.status !== "deleted" && <button className="control" onClick={() => setCorrecting((value) => !value)}><Pencil size={ICON_SIZE.sm} />Correct</button>}
          <button className="control" onClick={() => onFeedback("helpful")}><ThumbsUp size={ICON_SIZE.sm} />Helpful</button>
          <button className="control" onClick={() => onFeedback("harmful")}><ThumbsDown size={ICON_SIZE.sm} />Wrong</button>
          {record.status === "deleted" ? <button className="control" onClick={onRestore}><RotateCcw size={ICON_SIZE.sm} />Restore</button> : <button className="control" data-tone="danger" onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button>}
          </div>
          {correcting && <div className="goal-form-columns">
            {record.kind !== "preference" && <label className="goal-field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
            <label className="goal-field"><span>{record.kind === "preference" ? "Preference value" : "Content"}</span><textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} /></label>
            <label className="goal-field"><span>Correction reason <small>optional</small></span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this memory changed" /></label>
            <div className="memory-inline-actions"><button className="control" onClick={() => setCorrecting(false)}>Cancel</button><button className="control" data-variant="primary" disabled={!canSaveCorrection} onClick={() => onCorrect(title.trim(), content.trim(), reason.trim())}>Save correction</button></div>
          </div>}
        </div>
      </details>
      <small data-mono>
        Created {formatMemoryDate(record.createdAt)} · updated {formatMemoryDate(record.updatedAt)}
      </small>
    </div>
  );
}

export function TopicDetail({ topic, onForget, onRestore }: { topic: ColdTopic; onForget: () => void; onRestore: () => void }) {
  return (
    <div className="memory-detail-content">
      <span className="memory-kind">cold · {topic.descriptor.kind}</span>
      <h3>{topic.descriptor.title}</h3>
      <p>{topic.descriptor.description}</p>
      <small data-mono>revision {topic.revision.revision} · {topic.revision.tokenCount.toLocaleString()} tokens · {topic.descriptor.status} · full page</small>
      <section className="cold-document">
        <span>Canonical document</span>
        <div><Markdown>{topic.body}</Markdown></div>
      </section>
      <section>
        <span>Topic ID</span>
        <code>{topic.descriptor.topicId}</code>
      </section>
      <details className="memory-disclosure">
        <summary><strong>Topic controls</strong><small>{topic.descriptor.status === "deleted" ? "Recovery" : "Destructive"}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="memory-disclosure-body"><div className="memory-inline-actions">{topic.descriptor.status === "deleted" ? <button className="control" onClick={onRestore}><RotateCcw size={ICON_SIZE.sm} />Restore</button> : <button className="control" data-tone="danger" onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button>}</div></div>
      </details>
      <small data-mono>
        Published {formatMemoryDate(topic.revision.publishedAt ?? topic.revision.createdAt)}
      </small>
    </div>
  );
}

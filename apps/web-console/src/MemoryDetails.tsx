import { Check, ChevronRight, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { ColdTopic, PreferenceRecord, WarmMemory } from "./api";
import { ICON_SIZE } from "./icon-size";
import { Markdown } from "./LazyMarkdown";
import { formatMemoryDate, memoryContent, memorySignal, memoryTitle } from "./memory-display";

export function RecordDetail({
  record,
  onForget,
  onGovern,
  onFeedback,
}: {
  record: WarmMemory;
  onForget: () => void;
  onGovern: (action: "approve" | "reject" | "resolve") => void;
  onFeedback: (signal: "helpful" | "harmful") => void;
}) {
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
        <summary><strong>Memory controls</strong><small>Feedback or forget</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="memory-disclosure-body"><div className="memory-inline-actions">
          {record.status === "candidate" && <><button className="control" onClick={() => onGovern("approve")}><Check size={ICON_SIZE.sm} />Approve</button><button className="control" onClick={() => onGovern("reject")}>Reject</button></>}
          {record.status === "disputed" && <button className="control" onClick={() => onGovern("resolve")}>Resolve</button>}
          <button className="control" onClick={() => onFeedback("helpful")}><ThumbsUp size={ICON_SIZE.sm} />Helpful</button>
          <button className="control" onClick={() => onFeedback("harmful")}><ThumbsDown size={ICON_SIZE.sm} />Wrong</button>
          <button className="control" data-tone="danger" onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button>
        </div></div>
      </details>
      <small data-mono>
        Created {formatMemoryDate(record.createdAt)} · updated {formatMemoryDate(record.updatedAt)}
      </small>
    </div>
  );
}

export function TopicDetail({ topic, onForget }: { topic: ColdTopic; onForget: () => void }) {
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
        <summary><strong>Topic controls</strong><small>Destructive</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="memory-disclosure-body"><div className="memory-inline-actions"><button className="control" data-tone="danger" onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button></div></div>
      </details>
      <small data-mono>
        Published {formatMemoryDate(topic.revision.publishedAt ?? topic.revision.createdAt)}
      </small>
    </div>
  );
}

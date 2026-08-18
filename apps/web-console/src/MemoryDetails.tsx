import { Check, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
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
      <header>
        <span className={`memory-kind ${record.kind}`}>{record.kind}</span>
        <button className="memory-danger" onClick={onForget}>
          <Trash2 size={ICON_SIZE.sm} />
          Forget
        </button>
      </header>
      <div className="memory-inline-actions">
        {record.status === "candidate" && (
          <>
            <button onClick={() => onGovern("approve")}>
              <Check size={ICON_SIZE.sm} />
              Approve
            </button>
            <button onClick={() => onGovern("reject")}>Reject</button>
          </>
        )}
        {record.status === "disputed" && <button onClick={() => onGovern("resolve")}>Resolve</button>}
        <button onClick={() => onFeedback("helpful")}>
          <ThumbsUp size={ICON_SIZE.sm} />
          Helpful
        </button>
        <button onClick={() => onFeedback("harmful")}>
          <ThumbsDown size={ICON_SIZE.sm} />
          Wrong
        </button>
      </div>
      <h3>{memoryTitle(record)}</h3>
      <div className="memory-detail-body">
        <Markdown>{memoryContent(record)}</Markdown>
      </div>
      {record.summary && record.summary !== memoryContent(record) && (
        <section>
          <span>Summary</span>
          <p>{record.summary}</p>
        </section>
      )}
      <dl>
        <div><dt>Tier</dt><dd>{record.tier}</dd></div>
        <div><dt>Status</dt><dd>{record.status}</dd></div>
        <div><dt>Confidence</dt><dd>{Math.round(record.confidence * 100)}%</dd></div>
        <div><dt>{record.kind === "preference" ? "Strength" : "Importance"}</dt><dd>{Math.round(memorySignal(record) * 100)}%</dd></div>
      </dl>
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
      <small className="memory-updated">
        Created {formatMemoryDate(record.createdAt)} · updated {formatMemoryDate(record.updatedAt)}
      </small>
    </div>
  );
}

export function TopicDetail({ topic, onForget }: { topic: ColdTopic; onForget: () => void }) {
  return (
    <div className="memory-detail-content topic-detail">
      <header>
        <span className="memory-kind cold">cold · {topic.descriptor.kind}</span>
        <button className="memory-danger" onClick={onForget}>
          <Trash2 size={ICON_SIZE.sm} />
          Forget
        </button>
      </header>
      <h3>{topic.descriptor.title}</h3>
      <p className="topic-description">{topic.descriptor.description}</p>
      <dl>
        <div><dt>Revision</dt><dd>{topic.revision.revision}</dd></div>
        <div><dt>Tokens</dt><dd>{topic.revision.tokenCount.toLocaleString()}</dd></div>
        <div><dt>Status</dt><dd>{topic.descriptor.status}</dd></div>
        <div><dt>Storage</dt><dd>full page</dd></div>
      </dl>
      <section className="cold-document">
        <span>Canonical document</span>
        <div><Markdown>{topic.body}</Markdown></div>
      </section>
      <section>
        <span>Topic ID</span>
        <code>{topic.descriptor.topicId}</code>
      </section>
      <small className="memory-updated">
        Published {formatMemoryDate(topic.revision.publishedAt ?? topic.revision.createdAt)}
      </small>
    </div>
  );
}

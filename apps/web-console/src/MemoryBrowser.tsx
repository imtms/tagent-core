import { Archive, BrainCircuit, Snowflake } from "lucide-react";
import type {
  CaptureJob,
  ColdTopic,
  CoreMemorySnapshot,
  RecallResult,
  ReindexJob,
  TopicDescriptor,
  WarmMemory,
} from "./api";
import { formatMemoryDate, memoryContent, memoryTitle } from "./memory-display";

interface MemoryRecallResultsProps {
  results: RecallResult | null;
  query: string;
  onClear: () => void;
  onOpenRecord: (recordId: string) => void;
  onSelectTopic: (topic: ColdTopic) => void;
}

export function MemoryRecallResults({
  results,
  query,
  onClear,
  onOpenRecord,
  onSelectTopic,
}: MemoryRecallResultsProps) {
  if (!results) return null;
  return (
    <section className="recall-results">
      <div className="memory-section-heading">
        <div>
          <span className="eyebrow">Dynamic recall</span>
          <h3>Results for “{query.trim()}”</h3>
        </div>
        <button onClick={onClear}>Clear</button>
      </div>
      <div className="recall-grid">
        {results.cards.map((card) => (
          <button key={card.id} onClick={() => onOpenRecord(card.id)}>
            <span className={`memory-kind ${card.kind}`}>{card.kind}</span>
            <strong>{card.title}</strong>
            <p>{card.content}</p>
            <small>{card.tier} · {Math.round(card.confidence * 100)}% confidence</small>
          </button>
        ))}
        {results.coldTopics.map((topic) => (
          <button key={topic.descriptor.topicId} onClick={() => onSelectTopic(topic)}>
            <span className="memory-kind cold">cold topic</span>
            <strong>{topic.descriptor.title}</strong>
            <p>{topic.descriptor.description}</p>
            <small>revision {topic.revision.revision} · full page</small>
          </button>
        ))}
      </div>
      <p className="recall-trace">
        {results.trace.candidateCount} candidates · {results.trace.topicIds.length} Cold route(s) · {results.trace.deniedCount} denied
      </p>
    </section>
  );
}

interface MemoryCoreProjectionProps {
  core: CoreMemorySnapshot | null;
  coreText: string;
  onCoreTextChange: (value: string) => void;
  onGenerate: () => void;
  onSave: () => void;
}

export function MemoryCoreProjection({
  core,
  coreText,
  onCoreTextChange,
  onGenerate,
  onSave,
}: MemoryCoreProjectionProps) {
  return (
    <section className="memory-list-section memory-core">
      <div className="memory-section-heading">
        <div>
          <span className="eyebrow">Stable injection</span>
          <h3>Core Memory Snapshot</h3>
        </div>
        <small>{core ? `revision ${core.revision} · ${core.tokenCount} tokens` : "not generated"}</small>
      </div>
      <textarea
        value={coreText}
        onChange={(event) => onCoreTextChange(event.target.value)}
        rows={10}
        placeholder="# Core Memory"
      />
      <div className="memory-inline-actions">
        <button onClick={onGenerate}>Generate</button>
        <button className="memory-primary" onClick={onSave}>Save projection</button>
      </div>
    </section>
  );
}

interface MemoryJobListsProps {
  reindexJobs: readonly ReindexJob[];
  jobs: readonly CaptureJob[];
}

export function MemoryJobLists({ reindexJobs, jobs }: MemoryJobListsProps) {
  return (
    <>
      <section className="memory-list-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Durable embeddings</span>
            <h3>Reindex jobs</h3>
          </div>
          <small>{reindexJobs.length} jobs</small>
        </div>
        <div className="memory-record-list">
          {reindexJobs.slice(0, 6).map((job) => (
            <div key={job.id} className="memory-job-row">
              <div>
                <span className={`memory-kind ${job.status === "active" ? "fact" : "procedure"}`}>{job.status}</span>
                <strong>{job.generation}</strong>
                <small>
                  {job.checkpoint.phase} · {job.checkpoint.processed}/{job.checkpoint.total ?? "?"} · {job.checkpoint.indexed} indexed · {job.checkpoint.skipped} skipped
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="memory-list-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Capture observability</span>
            <h3>Recent jobs</h3>
          </div>
          <small>{jobs.length} jobs</small>
        </div>
        <div className="memory-record-list">
          {jobs.slice(0, 12).map((job) => (
            <div key={job.id} className="memory-job-row">
              <div>
                <span className={`memory-kind ${job.status === "completed" ? "fact" : job.status === "completed_empty" ? "episode" : "procedure"}`}>{job.status}</span>
                <strong>
                  {job.request.sourceRefs.map((source) => `${source.sourceType}:${source.sourceId}`).join(", ") || "manual capture"}
                </strong>
                <small>
                  {job.attempts} attempt(s) · {job.proposalCount ?? 0} proposed · {job.persistedCount ?? 0} persisted
                  {job.errorCode ? ` · ${job.errorCode}` : ""}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

interface MemoryCatalogProps {
  records: readonly WarmMemory[];
  topics: readonly TopicDescriptor[];
  selectedRecordId: string;
  selectedTopicId: string;
  onOpenRecord: (recordId: string) => void;
  onOpenTopic: (topicId: string) => void;
  hasMoreRecords: boolean;
  loadingMoreRecords: boolean;
  onLoadMoreRecords: () => void;
  hasMoreTopics: boolean;
  loadingMoreTopics: boolean;
  onLoadMoreTopics: () => void;
}

export function MemoryCatalog({
  records,
  topics,
  selectedRecordId,
  selectedTopicId,
  onOpenRecord,
  onOpenTopic,
  hasMoreRecords,
  loadingMoreRecords,
  onLoadMoreRecords,
  hasMoreTopics,
  loadingMoreTopics,
  onLoadMoreTopics,
}: MemoryCatalogProps) {
  return (
    <>
      <section className="memory-list-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Hot + Warm</span>
            <h3>Memory cards</h3>
          </div>
          <small>{records.length} loaded</small>
        </div>
        {!records.length ? (
          <div className="memory-empty">
            <BrainCircuit size={22} />
            <strong>No matching memory cards</strong>
            <p>Captured memories appear here after passing policy gates.</p>
          </div>
        ) : (
          <div className="memory-record-list">
            {records.map((record) => (
              <button key={record.id} onClick={() => onOpenRecord(record.id)} className={selectedRecordId === record.id ? "active" : ""}>
                <span className={`tier-dot ${record.tier}`} />
                <div>
                  <span className={`memory-kind ${record.kind}`}>{record.kind}</span>
                  <strong>{memoryTitle(record)}</strong>
                  <p>{memoryContent(record)}</p>
                  <small>{record.tier} · {record.status} · {formatMemoryDate(record.updatedAt)}</small>
                </div>
                <span className="memory-confidence">{Math.round(record.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        )}
        {hasMoreRecords && (
          <button className="memory-load-more" onClick={onLoadMoreRecords} disabled={loadingMoreRecords}>
            {loadingMoreRecords ? "Loading…" : "Load more memory cards"}
          </button>
        )}
      </section>
      <section className="memory-list-section cold-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Cold archive</span>
            <h3>Canonical topic pages</h3>
          </div>
          <small>{topics.length} descriptors loaded</small>
        </div>
        {!topics.length ? (
          <div className="memory-empty compact">
            <Archive size={20} />
            <strong>No matching Cold topics</strong>
            <p>Stable Warm memories consolidate into complete local Markdown pages.</p>
          </div>
        ) : (
          <div className="topic-grid">
            {topics.map((topic) => (
              <button key={topic.topicId} onClick={() => onOpenTopic(topic.topicId)} className={selectedTopicId === topic.topicId ? "active" : ""}>
                <div>
                  <Snowflake size={15} />
                  <span>{topic.kind}</span>
                  <small>{topic.coldRevisionId ? "cold page" : "descriptor"}</small>
                </div>
                <strong>{topic.title}</strong>
                <p>{topic.description}</p>
                <footer>
                  <span>{topic.status}</span>
                  <span>{formatMemoryDate(topic.updatedAt)}</span>
                </footer>
              </button>
            ))}
          </div>
        )}
        {hasMoreTopics && (
          <button className="memory-load-more" onClick={onLoadMoreTopics} disabled={loadingMoreTopics}>
            {loadingMoreTopics ? "Loading…" : "Load more topics"}
          </button>
        )}
      </section>
    </>
  );
}

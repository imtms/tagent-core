import {
  Activity,
  BrainCircuit,
  ChevronRight,
  RefreshCw,
  Snowflake,
} from "lucide-react";
import type {
  CaptureJob,
  ColdTopic,
  CoreMemorySnapshot,
  RecallResult,
  ReindexJob,
  TopicDescriptor,
  WarmMemory,
} from "./api";
import { formatCount } from "./count-format";
import { ICON_SIZE } from "./icon-size";
import { formatMemoryDate, memoryContent, memoryTitle } from "./memory-display";

interface MemoryRecallResultsProps {
  results: RecallResult | null;
  query: string;
  onClear: () => void;
  onOpenRecord: (recordId: string) => void;
  onSelectTopic: (topic: ColdTopic) => void;
}

function reindexJobSummary(job: ReindexJob): string {
  return [
    job.checkpoint.phase,
    job.checkpoint.processed > 0 || (job.checkpoint.total ?? 0) > 0
      ? `${job.checkpoint.processed}/${job.checkpoint.total ?? "?"} processed`
      : "",
    job.checkpoint.indexed > 0 ? `${job.checkpoint.indexed} indexed` : "",
    job.checkpoint.skipped > 0 ? `${job.checkpoint.skipped} skipped` : "",
    job.checkpoint.failed > 0 ? `${job.checkpoint.failed} failed` : "",
  ].filter(Boolean).join(" · ");
}

function captureJobSummary(job: CaptureJob): string {
  return [
    job.attempts > 0 ? formatCount(job.attempts, "attempt") : "",
    (job.proposalCount ?? 0) > 0 ? `${job.proposalCount} proposed` : "",
    (job.persistedCount ?? 0) > 0 ? `${job.persistedCount} persisted` : "",
    job.errorCode ?? "",
  ].filter(Boolean).join(" · ");
}

function memoryJobTone(status: CaptureJob["status"] | ReindexJob["status"]): "info" | "success" | "warning" | "danger" | "neutral" {
  if (status === "running") return "info";
  if (status === "completed" || status === "ready" || status === "active") return "success";
  if (status === "queued" || status === "retryable_failed") return "warning";
  if (status === "failed" || status === "cancelled" || status === "dead_letter") return "danger";
  return "neutral";
}

function memoryJobLabel(status: CaptureJob["status"] | ReindexJob["status"]): string {
  return status.replaceAll("_", " ");
}

function MemoryJobState({ status }: { status: CaptureJob["status"] | ReindexJob["status"] }) {
  return <span className={`memory-job-state ${memoryJobTone(status)}`}><i className="memory-job-dot" />{memoryJobLabel(status)}</span>;
}

export function MemoryRecallResults({
  results,
  query,
  onClear,
  onOpenRecord,
  onSelectTopic,
}: MemoryRecallResultsProps) {
  if (!results) return null;
  const hasResults = results.cards.length > 0 || results.coldTopics.length > 0;
  const trace = [
    results.trace.candidateCount > 0 ? formatCount(results.trace.candidateCount, "candidate") : "",
    results.trace.topicIds.length > 0 ? formatCount(results.trace.topicIds.length, "cold route") : "",
    results.trace.deniedCount > 0 ? `${results.trace.deniedCount} denied` : "",
  ].filter(Boolean);
  return (
    <section className="recall-results">
      <div className="memory-section-heading">
        <div>
          <span className="eyebrow">Dynamic recall</span>
          <h3>Results for “{query.trim()}”</h3>
        </div>
        <button onClick={onClear}>Clear</button>
      </div>
      {hasResults && <div className="recall-grid">
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
      </div>}
      {!hasResults && <div className="memory-empty compact"><BrainCircuit size={ICON_SIZE.xl} /><strong>No recall matches</strong><p>Try a broader phrase or inspect the memory catalog below.</p></div>}
      {trace.length > 0 && <p className="recall-trace">{trace.join(" · ")}</p>}
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
  if (!core) {
    return (
      <section className="memory-list-section memory-core">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Stable injection</span>
            <h3>Core Memory Snapshot</h3>
          </div>
          <button onClick={onGenerate}>Generate snapshot</button>
        </div>
      </section>
    );
  }
  return (
    <details className="memory-disclosure memory-core">
      <summary>
        <BrainCircuit size={ICON_SIZE.sm} />
        <span>
          <strong>Core Memory snapshot</strong>
          <small>Stable context injected into new runs</small>
        </span>
        <small>revision {core.revision}{core.tokenCount > 0 ? ` · ${formatCount(core.tokenCount, "token")}` : ""}</small>
        <ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />
      </summary>
      <div className="memory-disclosure-body">
        <textarea
          value={coreText}
          onChange={(event) => onCoreTextChange(event.target.value)}
          rows={10}
          placeholder="# Core Memory"
        />
        <div className="memory-inline-actions">
          <button onClick={onGenerate}>Regenerate</button>
          <button className="memory-primary" onClick={onSave}>Save projection</button>
        </div>
      </div>
    </details>
  );
}

interface MemoryJobListsProps {
  reindexJobs: readonly ReindexJob[];
  jobs: readonly CaptureJob[];
  busy: boolean;
  onReindex: () => void;
}

export function MemoryJobLists({ reindexJobs, jobs, busy, onReindex }: MemoryJobListsProps) {
  const total = reindexJobs.length + jobs.length;
  return (
    <details className="memory-disclosure memory-operations">
      <summary>
        <Activity size={ICON_SIZE.sm} />
        <span>
          <strong>Memory operations</strong>
          <small>Capture and durable index activity</small>
        </span>
        <small>{total > 0 ? formatCount(total, "job") : "Maintenance"}</small>
        <ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />
      </summary>
      <div className="memory-disclosure-body memory-operations-body">
        <div className="memory-operations-actions">
          <button onClick={onReindex} disabled={busy}>
            <RefreshCw size={ICON_SIZE.sm} className={busy ? "spin" : ""} />
            Reindex durable memory
          </button>
        </div>
        {reindexJobs.length > 0 && <section className="memory-operation-group">
          <header><span>Durable index</span><small>{formatCount(reindexJobs.length, "job")}</small></header>
          <div className="memory-record-list">
            {reindexJobs.slice(0, 6).map((job) => (
              <div key={job.id} className="memory-job-row">
                <div>
                  <MemoryJobState status={job.status} />
                  <strong>{job.generation}</strong>
                  <small>{reindexJobSummary(job)}</small>
                </div>
              </div>
            ))}
          </div>
        </section>}
        {jobs.length > 0 && <section className="memory-operation-group">
          <header><span>Recent capture</span><small>{formatCount(jobs.length, "job")}</small></header>
          <div className="memory-record-list">
            {jobs.slice(0, 12).map((job) => {
              const summary = captureJobSummary(job);
              return <div key={job.id} className="memory-job-row">
                <div>
                  <MemoryJobState status={job.status} />
                  <strong>
                    {job.request.sourceRefs.map((source) => `${source.sourceType}:${source.sourceId}`).join(", ") || "manual capture"}
                  </strong>
                  {summary && <small>{summary}</small>}
                </div>
              </div>
            })}
          </div>
        </section>}
      </div>
    </details>
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
  const showRecords = records.length > 0 || hasMoreRecords;
  const showTopics = topics.length > 0 || hasMoreTopics;
  if (!showRecords && !showTopics) return null;
  return (
    <>
      {showRecords && <section className="memory-list-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Hot + Warm</span>
            <h3>Memory cards</h3>
          </div>
          {records.length > 0 && <small>{formatCount(records.length, "card")} loaded</small>}
        </div>
        {records.length > 0 && <div className="memory-record-list">
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
          </div>}
        {hasMoreRecords && (
          <button className="memory-load-more" onClick={onLoadMoreRecords} disabled={loadingMoreRecords}>
            {loadingMoreRecords ? "Loading…" : "Load more memory cards"}
          </button>
        )}
      </section>}
      {showTopics && <section className="memory-list-section cold-section">
        <div className="memory-section-heading">
          <div>
            <span className="eyebrow">Cold archive</span>
            <h3>Canonical topic pages</h3>
          </div>
          {topics.length > 0 && <small>{formatCount(topics.length, "topic")} loaded</small>}
        </div>
        {topics.length > 0 && <div className="topic-grid">
            {topics.map((topic) => (
              <button key={topic.topicId} onClick={() => onOpenTopic(topic.topicId)} className={selectedTopicId === topic.topicId ? "active" : ""}>
                <div>
                  <Snowflake size={ICON_SIZE.md} />
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
          </div>}
        {hasMoreTopics && (
          <button className="memory-load-more" onClick={onLoadMoreTopics} disabled={loadingMoreTopics}>
            {loadingMoreTopics ? "Loading…" : "Load more topics"}
          </button>
        )}
      </section>}
    </>
  );
}

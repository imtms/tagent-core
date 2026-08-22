import { useState } from "react";
import {
  Activity,
  BrainCircuit,
  ChevronRight,
  RefreshCw,
  RotateCcw,
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
import { formatMemoryDate, memoryContent, memoryTextRepeats, memoryTitle, memoryTitleRepeatsContent } from "./memory-display";

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

function memoryJobTone(status: CaptureJob["status"] | ReindexJob["status"]): "info" | "success" | "warning" | "danger" | undefined {
  if (status === "running") return "info";
  if (status === "completed" || status === "ready" || status === "active") return "success";
  if (status === "queued" || status === "retryable_failed") return "warning";
  if (status === "failed" || status === "cancelled" || status === "dead_letter") return "danger";
  return undefined;
}

function memoryJobLabel(status: CaptureJob["status"] | ReindexJob["status"]): string {
  return status.replaceAll("_", " ");
}

function MemoryJobState({ status }: { status: CaptureJob["status"] | ReindexJob["status"] }) {
  return <span className="status-label" data-tone={memoryJobTone(status)}><i className="status-dot" />{memoryJobLabel(status)}</span>;
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
  const candidates = results.trace.candidates ?? [];
  const coldRoutes = results.trace.coldTopicRoutes ?? [];
  const hasDiagnostics = Boolean(results.trace.embedding || results.trace.policyTransforms || candidates.length || coldRoutes.length);
  return (
    <section className="memory-list-section">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Dynamic recall</span>
          <h3>Results for “{query.trim()}”</h3>
        </div>
        <button className="control" onClick={onClear}>Clear</button>
      </div>
      {hasResults && <div className="memory-list">
        {results.cards.map((card) => {
          const repeated = memoryTextRepeats(card.title, card.content);
          return <button key={card.id} onClick={() => onOpenRecord(card.id)}>
            <div><strong>{repeated ? card.content : card.title}</strong>{!repeated && <p>{card.content}</p>}<small data-mono>{card.kind} · {card.tier} · {Math.round(card.confidence * 100)}% confidence · {Math.round(card.score * 100)}% relevance{card.retrievalChannels?.length ? ` · ${card.retrievalChannels.join(" + ")}` : ""}</small></div>
          </button>;
        })}
        {results.coldTopics.map((topic) => {
          const repeated = memoryTextRepeats(topic.descriptor.title, topic.descriptor.description);
          return <button key={topic.descriptor.topicId} onClick={() => onSelectTopic(topic)}>
            <div><strong>{repeated ? topic.descriptor.description : topic.descriptor.title}</strong>{!repeated && <p>{topic.descriptor.description}</p>}<small data-mono>cold topic · revision {topic.revision.revision} · full page</small></div>
          </button>;
        })}
      </div>}
      {!hasResults && <div className="memory-empty"><BrainCircuit size={ICON_SIZE.xl} /><strong>No recall matches</strong><p>Try a broader phrase or inspect the memory catalog below.</p></div>}
      {hasDiagnostics ? <details className="memory-disclosure">
        <summary><Activity size={ICON_SIZE.sm} /><strong>Recall diagnostics</strong><small>{trace.join(" · ") || "Trace"}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="memory-disclosure-body">
          {results.trace.embedding && <section><strong>Embedding</strong><p>{results.trace.embedding.configured ? results.trace.embedding.degraded ? "Degraded; lexical and graph paths remained available" : "Available" : "Not configured"}{results.trace.embedding.generation ? ` · ${results.trace.embedding.generation}` : ""}</p>{results.trace.embedding.error && <small>{results.trace.embedding.error}</small>}</section>}
          {Boolean(results.trace.policyTransforms) && <section><strong>Policy transforms</strong><p>{formatCount(results.trace.policyTransforms ?? 0, "candidate")} transformed before presentation.</p></section>}
          {coldRoutes.length > 0 && <section><strong>Cold routes</strong><div className="memory-list">{coldRoutes.map((route) => <div key={route.topicId}><div><strong>{route.topicId}</strong><small>{route.selected ? "selected" : "not selected"} · {route.channels.join(" + ")} · {route.reason}</small></div></div>)}</div></section>}
          {candidates.length > 0 && <section><strong>Candidate outcomes</strong><div className="memory-list">{candidates.map((candidate) => <div key={`${candidate.id}:${candidate.outcome}`}><div><strong>{candidate.id}</strong><small>{candidate.outcome.replaceAll("_", " ")} · {candidate.channels.join(" + ")}{candidate.finalScore === undefined ? "" : ` · ${Math.round(candidate.finalScore * 100)}% final`}{candidate.reason ? ` · ${candidate.reason}` : ""}</small>{candidate.scoreBreakdown && <small data-mono>{Object.entries(candidate.scoreBreakdown).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(" · ")}</small>}</div></div>)}</div></section>}
        </div>
      </details> : trace.length > 0 && <small>{trace.join(" · ")}</small>}
    </section>
  );
}

interface MemoryCoreProjectionProps {
  core: CoreMemorySnapshot | null;
  coreText: string;
  busy?: boolean;
  onCoreTextChange: (value: string) => void;
  onGenerate: () => void;
  onSave: () => void;
}

export function MemoryCoreProjection({
  core,
  coreText,
  busy = false,
  onCoreTextChange,
  onGenerate,
  onSave,
}: MemoryCoreProjectionProps) {
  if (!core) {
    return (
      <section className="memory-list-section">
        <div className="section-heading">
          <div>
            <h3>Core Memory Snapshot</h3>
          </div>
          <button className="control" disabled={busy} onClick={onGenerate}>Generate snapshot</button>
        </div>
      </section>
    );
  }
  return (
    <section className="memory-list-section">
      <div className="section-heading">
        <div><h3>Core Memory snapshot</h3><small>revision {core.revision}{core.tokenCount > 0 ? ` · ${formatCount(core.tokenCount, "token")}` : ""}</small></div>
        <button className="control" disabled={busy} onClick={onGenerate}>Regenerate</button>
      </div>
      <div>
        <div className="goal-field">
          <textarea
            aria-label="Core Memory projection"
            value={coreText}
            onChange={(event) => onCoreTextChange(event.target.value)}
            rows={10}
            placeholder="# Core Memory"
          />
        </div>
        <div className="memory-inline-actions">
          <button className="control" data-variant="primary" disabled={busy} onClick={onSave}>Save projection</button>
        </div>
      </div>
    </section>
  );
}

interface MemoryJobListsProps {
  reindexJobs: readonly ReindexJob[];
  jobs: readonly CaptureJob[];
  busy: boolean;
  onReindex: () => void;
  onRestore?: (recordIds: string[], topicIds: string[]) => void;
}

export function MemoryJobLists({ reindexJobs, jobs, busy, onReindex, onRestore }: MemoryJobListsProps) {
  const total = reindexJobs.length + jobs.length;
  const [recordIds, setRecordIds] = useState("");
  const [topicIds, setTopicIds] = useState("");
  const restoreRecords = ids(recordIds);
  const restoreTopics = ids(topicIds);
  return (
    <section className="memory-list-section">
      <div className="section-heading">
        <div><span className="eyebrow">Maintenance and recovery</span></div>
        <div className="memory-operations-actions">
          <button className="control" onClick={onReindex} disabled={busy}>
            <RefreshCw size={ICON_SIZE.sm} className={busy ? "spin" : ""} />
            Reindex durable memory
          </button>
        </div>
      </div>
      <div>
        {onRestore && <details className="memory-disclosure">
          <summary><RotateCcw size={ICON_SIZE.sm} /><strong>Restore forgotten memory</strong><small>Record or Topic IDs</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
          <div className="memory-disclosure-body">
            <p data-meta>Forgotten items are hidden from the catalog. Paste record or topic IDs from an audit receipt before their grace period ends.</p>
            <div className="goal-form-columns">
              <label className="goal-field"><span>Record IDs <small>comma or line separated</small></span><textarea rows={3} value={recordIds} onChange={(event) => setRecordIds(event.target.value)} /></label>
              <label className="goal-field"><span>Topic IDs <small>comma or line separated</small></span><textarea rows={3} value={topicIds} onChange={(event) => setTopicIds(event.target.value)} /></label>
            </div>
            <div className="memory-inline-actions"><button className="control" data-variant="primary" disabled={busy || restoreRecords.length + restoreTopics.length === 0} onClick={() => onRestore(restoreRecords, restoreTopics)}><RotateCcw size={ICON_SIZE.sm} />Restore selected IDs</button></div>
          </div>
        </details>}
        {reindexJobs.length > 0 && <section className="memory-operation-group">
          <header className="section-heading"><strong>Durable index</strong><small>{formatCount(reindexJobs.length, "job")}</small></header>
          <div className="memory-list">
            {reindexJobs.slice(0, 6).map((job) => (
              <div key={job.id}>
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
          <header className="section-heading"><strong>Recent captures</strong><small>{formatCount(jobs.length, "job")}</small></header>
          <div className="memory-list">
            {jobs.slice(0, 12).map((job) => {
              const summary = captureJobSummary(job);
              return <div key={job.id}>
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
        {total === 0 && <p data-meta>Capture and reindex jobs will appear here with their current state and outcome.</p>}
      </div>
    </section>
  );
}

function ids(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

interface MemoryCatalogProps {
  view?: "all" | "records" | "topics";
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
  view = "all",
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
  const showRecords = view !== "topics" && (records.length > 0 || hasMoreRecords);
  const showTopics = view !== "records" && (topics.length > 0 || hasMoreTopics);
  if (!showRecords && !showTopics) return null;
  return (
    <>
      {showRecords && <section className="memory-list-section">
        <div className="section-heading">
          <h3>Hot + Warm memory</h3>
          {records.length > 0 && <small>{formatCount(records.length, "card")} loaded</small>}
        </div>
        {records.length > 0 && <div className="memory-list">
            {records.map((record) => (
              <button key={record.id} onClick={() => onOpenRecord(record.id)} aria-current={selectedRecordId === record.id ? "true" : undefined}>
                <span className="tier-dot" data-tone={record.tier === "hot" ? "accent" : undefined} />
                <div>
                  <strong>{memoryTitleRepeatsContent(record) ? memoryContent(record) : memoryTitle(record)}</strong>
                  {!memoryTitleRepeatsContent(record) && <p>{memoryContent(record)}</p>}
                  <small data-mono>{record.kind} · {record.tier} · {record.status} · {formatMemoryDate(record.updatedAt)}</small>
                </div>
                <small data-mono>{Math.round(record.confidence * 100)}%</small>
              </button>
            ))}
          </div>}
        {hasMoreRecords && (
          <button className="memory-load-more" onClick={onLoadMoreRecords} disabled={loadingMoreRecords}>
            {loadingMoreRecords ? "Loading…" : "Load more memory cards"}
          </button>
        )}
      </section>}
      {showTopics && <section className="memory-list-section">
        <div className="section-heading">
          <h3>Cold topic archive</h3>
          {topics.length > 0 && <small>{formatCount(topics.length, "topic")} loaded</small>}
        </div>
        {topics.length > 0 && <div className="memory-list">
            {topics.map((topic) => {
              const repeated = memoryTextRepeats(topic.title, topic.description);
              return <button key={topic.topicId} onClick={() => onOpenTopic(topic.topicId)} aria-current={selectedTopicId === topic.topicId ? "true" : undefined}>
                <Snowflake size={ICON_SIZE.md} />
                <div>
                  <strong>{repeated ? topic.description : topic.title}</strong>
                  {!repeated && <p>{topic.description}</p>}
                  <small data-mono>{topic.kind} · {topic.coldRevisionId ? "cold page" : "descriptor"} · {topic.status} · {formatMemoryDate(topic.updatedAt)}</small>
                </div>
              </button>;
            })}
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

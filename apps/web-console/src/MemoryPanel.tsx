import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  api,
  type CaptureJob,
  type ColdTopic,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatusResult,
  type RecallResult,
  type ReindexJob,
  type RuntimeStatus,
  type TopicDescriptor,
  type WarmMemory,
  type CoreMemorySnapshot,
} from "./api";
import { RecordDetail, TopicDetail } from "./MemoryDetails";
import {
  MemoryCatalog,
  MemoryCoreProjection,
  MemoryJobLists,
  MemoryRecallResults,
} from "./MemoryBrowser";
import { MemoryOverview } from "./MemoryOverview";
import { memoryContent, memoryTitle } from "./memory-display";
import {
  MEMORY_PAGE_REQUEST_LIMIT,
  memoryPageWindow,
  mergeMemoryPage,
} from "./memory-pagination";

export function MemoryPanel({
  runtime,
  onClose,
}: {
  runtime: RuntimeStatus;
  onClose: () => void;
}) {
  const scope = useMemo<MemoryScope>(
    () => ({
      type: "workspace",
      id: runtime.memoryWorkspaceScopeId ?? "default",
    }),
    [runtime.memoryWorkspaceScopeId],
  );
  const [status, setStatus] = useState<MemoryStatusResult | null>(null);
  const [records, setRecords] = useState<WarmMemory[]>([]);
  const [topics, setTopics] = useState<TopicDescriptor[]>([]);
  const [jobs, setJobs] = useState<CaptureJob[]>([]);
  const [reindexJobs, setReindexJobs] = useState<ReindexJob[]>([]);
  const [core, setCore] = useState<CoreMemorySnapshot | null>(null);
  const [coreText, setCoreText] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | MemoryKind>("all");
  const [results, setResults] = useState<RecallResult | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<WarmMemory | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<ColdTopic | null>(null);
  const [recordSnapshotCreatedAt, setRecordSnapshotCreatedAt] =
    useState<number>();
  const [recordAfter, setRecordAfter] = useState<{
    createdAt: number;
    id: string;
  }>();
  const [topicSnapshotCreatedAt, setTopicSnapshotCreatedAt] =
    useState<number>();
  const [topicAfter, setTopicAfter] = useState<{
    createdAt: number;
    topicId: string;
  }>();
  const [hasMoreRecords, setHasMoreRecords] = useState(false);
  const [hasMoreTopics, setHasMoreTopics] = useState(false);
  const [loadingMoreRecords, setLoadingMoreRecords] = useState(false);
  const [loadingMoreTopics, setLoadingMoreTopics] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedRecordIdRef = useRef("");
  const selectedTopicIdRef = useRef("");

  useEffect(() => {
    selectedRecordIdRef.current = selectedRecord?.id ?? "";
  }, [selectedRecord]);
  useEffect(() => {
    selectedTopicIdRef.current = selectedTopic?.descriptor.topicId ?? "";
  }, [selectedTopic]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const selectedRecordId = selectedRecordIdRef.current;
      const selectedTopicId = selectedTopicIdRef.current;
      const [
        nextStatus,
        recordPage,
        topicPage,
        nextJobs,
        nextReindex,
        nextCore,
        refreshedRecord,
        refreshedTopic,
      ] = await Promise.all([
        api.memoryStatus(scope),
        api.memoryRecordsPage(scope, { limit: MEMORY_PAGE_REQUEST_LIMIT }),
        api.memoryTopicsPage(scope, { limit: MEMORY_PAGE_REQUEST_LIMIT }),
        api.memoryJobs(scope),
        api.memoryReindexJobs(scope),
        api.memoryCoreSnapshot(scope),
        selectedRecordId
          ? api.memoryRecord(scope, selectedRecordId)
          : Promise.resolve(null),
        selectedTopicId
          ? api.memoryTopic(scope, selectedTopicId)
          : Promise.resolve(null),
      ]);
      const nextRecords = memoryPageWindow(recordPage.records, (record) => ({
        createdAt: record.createdAt,
        id: record.id,
      }));
      const nextTopics = memoryPageWindow(topicPage.topics, (topic) => ({
        createdAt: topic.createdAt,
        topicId: topic.topicId,
      }));
      setStatus(nextStatus);
      setRecords(nextRecords.items);
      setRecordSnapshotCreatedAt(recordPage.snapshotCreatedAt);
      setRecordAfter(nextRecords.after);
      setHasMoreRecords(nextRecords.hasMore);
      setTopics(nextTopics.items);
      setTopicSnapshotCreatedAt(topicPage.snapshotCreatedAt);
      setTopicAfter(nextTopics.after);
      setHasMoreTopics(nextTopics.hasMore);
      setJobs(nextJobs);
      setReindexJobs(nextReindex);
      setCore(nextCore);
      setCoreText(nextCore?.markdown ?? "");
      setSelectedRecord(refreshedRecord);
      setSelectedTopic(refreshedTopic);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [scope]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter(
      (record) =>
        (kind === "all" || record.kind === kind) &&
        (!needle ||
          `${memoryTitle(record)} ${memoryContent(record)} ${record.summary} ${record.topicIds.join(" ")}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [records, query, kind]);
  const filteredTopics = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return topics.filter(
      (topic) =>
        (kind === "all" || topic.kind === kind) &&
        (!needle ||
          `${topic.title} ${topic.description}`.toLowerCase().includes(needle)),
    );
  }, [topics, query, kind]);

  async function searchMemory() {
    const cue = query.trim();
    if (!cue) {
      setResults(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setResults(
        await api.memoryRecall(scope, cue, kind === "all" ? undefined : [kind]),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function loadMoreRecords() {
    if (
      loadingMoreRecords ||
      !hasMoreRecords ||
      recordSnapshotCreatedAt === undefined ||
      !recordAfter
    )
      return;
    setLoadingMoreRecords(true);
    setError("");
    try {
      const page = await api.memoryRecordsPage(scope, {
        snapshotCreatedAt: recordSnapshotCreatedAt,
        after: recordAfter,
        limit: MEMORY_PAGE_REQUEST_LIMIT,
      });
      const next = memoryPageWindow(page.records, (record) => ({
        createdAt: record.createdAt,
        id: record.id,
      }));
      setRecords((current) =>
        mergeMemoryPage(current, next.items, (record) => record.id),
      );
      setRecordAfter(next.after);
      setHasMoreRecords(next.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMoreRecords(false);
    }
  }
  async function loadMoreTopics() {
    if (
      loadingMoreTopics ||
      !hasMoreTopics ||
      topicSnapshotCreatedAt === undefined ||
      !topicAfter
    )
      return;
    setLoadingMoreTopics(true);
    setError("");
    try {
      const page = await api.memoryTopicsPage(scope, {
        snapshotCreatedAt: topicSnapshotCreatedAt,
        after: topicAfter,
        limit: MEMORY_PAGE_REQUEST_LIMIT,
      });
      const next = memoryPageWindow(page.topics, (topic) => ({
        createdAt: topic.createdAt,
        topicId: topic.topicId,
      }));
      setTopics((current) =>
        mergeMemoryPage(current, next.items, (topic) => topic.topicId),
      );
      setTopicAfter(next.after);
      setHasMoreTopics(next.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMoreTopics(false);
    }
  }
  async function openRecord(recordId: string) {
    setSelectedTopic(null);
    const current = records.find((record) => record.id === recordId);
    if (current) {
      setSelectedRecord(current);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setSelectedRecord(await api.memoryRecord(scope, recordId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function openTopic(topicId: string) {
    setSelectedRecord(null);
    setBusy(true);
    setError("");
    try {
      setSelectedTopic(await api.memoryTopic(scope, topicId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function capture() {
    if (!captureText.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.memoryCapture(scope, captureText.trim());
      setCaptureText("");
      setCaptureOpen(false);
      setMessage(
        "Memory queued. Policy gates and the lifecycle worker will process it shortly.",
      );
      window.setTimeout(() => void refresh(), 1400);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function forgetRecord(record: WarmMemory) {
    if (!window.confirm(`Forget “${memoryTitle(record)}”?`)) return;
    setBusy(true);
    try {
      await api.memoryForget(scope, [record.id]);
      setSelectedRecord(null);
      setMessage("Memory forgotten.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function govern(
    record: WarmMemory,
    action: "approve" | "reject" | "resolve",
  ) {
    setBusy(true);
    try {
      await api.memoryGovern(scope, record.id, action, {
        resolution: action === "resolve" ? "accept" : undefined,
      });
      setMessage(`Memory ${action}d.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function feedback(record: WarmMemory, signal: "helpful" | "harmful") {
    setBusy(true);
    try {
      await api.memoryFeedback(scope, record.id, signal);
      setMessage("Recall feedback recorded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function runReindex() {
    setBusy(true);
    try {
      await api.memoryReindex(scope);
      setMessage("Durable reindex queued.");
      window.setTimeout(() => void refresh(), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function saveCore() {
    setBusy(true);
    try {
      const next = await api.memoryCoreSnapshot(scope, { markdown: coreText });
      setCore(next);
      setMessage("Core Memory projection saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function generateCore() {
    setError("");
    setMessage("");
    try {
      await api.memoryCoreSnapshot(scope, { generate: true });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function forgetTopic(topic: ColdTopic) {
    if (!window.confirm(`Forget the Cold topic “${topic.descriptor.title}”?`))
      return;
    setBusy(true);
    try {
      await api.memoryForget(scope, undefined, [topic.descriptor.topicId]);
      setSelectedTopic(null);
      setMessage(
        "Cold topic tombstoned; revisions remain restorable during grace period.",
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="memory-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Memory center"
    >
      <button
        className="memory-backdrop"
        onClick={onClose}
        aria-label="Close memory center"
      />
      <section className="memory-center">
        <header className="memory-header">
          <div className="memory-heading-icon">
            <BrainCircuit size={21} />
          </div>
          <div>
            <span className="eyebrow">Long-term memory</span>
            <h2>Memory center</h2>
            <p>
              Inspect recall, memory tiers, provenance and canonical topics.
            </p>
          </div>
          <div className="memory-header-actions">
            <span className="memory-live">
              <span />
              Enabled
            </span>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              aria-label="Refresh memory"
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Close memory center"
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="memory-toolbar">
          <form
            className="memory-search"
            onSubmit={(event) => {
              event.preventDefault();
              void searchMemory();
            }}
          >
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search facts, preferences, episodes, procedures or topics"
            />
            <button type="submit">Recall</button>
          </form>
          <button onClick={() => void runReindex()}>
            <RefreshCw size={14} /> Reindex
          </button>
          <button
            className="memory-primary"
            onClick={() => setCaptureOpen(true)}
          >
            <Plus size={16} />
            Add memory
          </button>
        </div>
        {error && <div className="memory-alert error">{error}</div>}
        {message && <div className="memory-alert success">{message}</div>}
        <div className="memory-content">
          <MemoryOverview
            scope={scope}
            runtime={runtime}
            status={status}
            kind={kind}
            onKindChange={setKind}
            records={records}
            topics={topics}
          />
          <main className="memory-browser">
            <MemoryRecallResults
              results={results}
              query={query}
              onClear={() => setResults(null)}
              onOpenRecord={(recordId) => void openRecord(recordId)}
              onSelectTopic={(topic) => {
                setSelectedRecord(null);
                setSelectedTopic(topic);
              }}
            />
            <MemoryCoreProjection
              core={core}
              coreText={coreText}
              onCoreTextChange={setCoreText}
              onGenerate={() => void generateCore()}
              onSave={() => void saveCore()}
            />
            <MemoryJobLists reindexJobs={reindexJobs} jobs={jobs} />
            <MemoryCatalog
              records={filteredRecords}
              topics={filteredTopics}
              selectedRecordId={selectedRecord?.id ?? ""}
              selectedTopicId={selectedTopic?.descriptor.topicId ?? ""}
              onOpenRecord={(recordId) => void openRecord(recordId)}
              onOpenTopic={(topicId) => void openTopic(topicId)}
              hasMoreRecords={hasMoreRecords}
              loadingMoreRecords={loadingMoreRecords}
              onLoadMoreRecords={() => void loadMoreRecords()}
              hasMoreTopics={hasMoreTopics}
              loadingMoreTopics={loadingMoreTopics}
              onLoadMoreTopics={() => void loadMoreTopics()}
            />
          </main>
          <aside
            className={`memory-detail ${selectedRecord || selectedTopic ? "open" : ""}`}
          >
            {!selectedRecord && !selectedTopic ? (
              <div className="memory-detail-empty">
                <BrainCircuit size={24} />
                <strong>Select a memory</strong>
                <p>
                  Review provenance, confidence, topic links and Cold content.
                </p>
              </div>
            ) : selectedRecord ? (
              <RecordDetail
                record={selectedRecord}
                onForget={() => void forgetRecord(selectedRecord)}
                onGovern={(action) => void govern(selectedRecord, action)}
                onFeedback={(signal) => void feedback(selectedRecord, signal)}
              />
            ) : selectedTopic ? (
              <TopicDetail
                topic={selectedTopic}
                onForget={() => void forgetTopic(selectedTopic)}
              />
            ) : null}
          </aside>
        </div>
      </section>
      {captureOpen && (
        <div className="memory-modal-wrap">
          <button
            className="memory-modal-backdrop"
            onClick={() => setCaptureOpen(false)}
            aria-label="Close add memory"
          />
          <section className="memory-modal">
            <header>
              <div>
                <span className="eyebrow">Policy-gated capture</span>
                <h3>Add a memory cue</h3>
              </div>
              <button
                className="icon-button"
                onClick={() => setCaptureOpen(false)}
                aria-label="Close add memory"
              >
                <X size={17} />
              </button>
            </header>
            <p>
              Write a fact, preference, event or procedure. Sensitive values are
              inspected before durable storage.
            </p>
            <textarea
              autoFocus
              value={captureText}
              onChange={(event) => setCaptureText(event.target.value)}
              placeholder="Example: I prefer concise Chinese answers, but architecture reviews should include trade-offs."
              rows={7}
            />
            <footer>
              <span>
                <ShieldCheck size={14} />
                Scope: {scope.id}
              </span>
              <div>
                <button onClick={() => setCaptureOpen(false)}>Cancel</button>
                <button
                  className="memory-primary"
                  onClick={() => void capture()}
                  disabled={!captureText.trim() || busy}
                >
                  Queue memory
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

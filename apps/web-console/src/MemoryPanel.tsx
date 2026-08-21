import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  ChevronLeft,
  Download,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { ICON_SIZE } from "./icon-size";
import {
  api,
  type CaptureJob,
  type ColdTopic,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
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
import { memoryContent, memoryStatusSummary, memoryTextRepeats, memoryTitle, memoryTitleRepeatsContent } from "./memory-display";
import {
  MEMORY_PAGE_REQUEST_LIMIT,
  memoryPageWindow,
  mergeMemoryPage,
} from "./memory-pagination";

const memoryKinds = [
  { value: "all", label: "All" },
  { value: "fact", label: "Facts" },
  { value: "preference", label: "Preferences" },
  { value: "episode", label: "Episodes" },
  { value: "procedure", label: "Procedures" },
] as const satisfies readonly { value: "all" | MemoryKind; label: string }[];

const memoryStatuses = [
  { value: "all", label: "Any state" },
  { value: "active", label: "Active" },
  { value: "candidate", label: "Candidates" },
  { value: "disputed", label: "Disputed" },
  { value: "stale", label: "Stale" },
  { value: "superseded", label: "Superseded" },
  { value: "quarantined", label: "Quarantined" },
] as const satisfies readonly { value: "all" | MemoryStatus; label: string }[];

export interface ForgottenMemoryUndo {
  ids: string[];
  topicIds: string[];
  label: string;
  purgeAfter?: number;
}

export function MemoryUndoNotice({ item, busy, onUndo }: { item: ForgottenMemoryUndo; busy: boolean; onUndo: () => void }) {
  return <div className="notice" data-tone="warning" role="status"><span><strong>Forgot “{item.label}”</strong>{item.purgeAfter && <small> · Restorable until {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(item.purgeAfter)}</small>}</span><button className="control" disabled={busy} onClick={onUndo}><RotateCcw size={ICON_SIZE.sm} />Undo</button></div>;
}

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
  const [memoryStatus, setMemoryStatus] = useState<"all" | MemoryStatus>("all");
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
  const [recentForget, setRecentForget] = useState<ForgottenMemoryUndo | null>(null);
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
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [message]);

  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter(
      (record) =>
        (kind === "all" || record.kind === kind) &&
        (memoryStatus === "all" || record.status === memoryStatus) &&
        (!needle ||
          `${memoryTitle(record)} ${memoryContent(record)} ${record.summary} ${record.topicIds.join(" ")}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [records, query, kind, memoryStatus]);
  const filteredTopics = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return topics.filter(
      (topic) =>
        (kind === "all" || topic.kind === kind) &&
        (memoryStatus === "all" || topic.status === memoryStatus) &&
        (!needle ||
          `${topic.title} ${topic.description}`.toLowerCase().includes(needle)),
    );
  }, [topics, query, kind, memoryStatus]);

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
    const label = memoryTitleRepeatsContent(record) ? memoryContent(record) : memoryTitle(record);
    if (!window.confirm(`Forget “${label}”?`)) return;
    setBusy(true);
    try {
      const result = await api.memoryForget(scope, [record.id]);
      setSelectedRecord(null);
      setMessage("");
      setRecentForget({ ids: [record.id], topicIds: [], label, purgeAfter: result.purgeAfter });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function govern(
    record: WarmMemory,
    action: "approve" | "reject" | "resolve" | "correct",
    options: { resolution?: "accept" | "reject"; title?: string; content?: string; reason?: string } = {},
  ) {
    setBusy(true);
    try {
      await api.memoryGovern(scope, record.id, action, options);
      setMessage(action === "correct" ? "Memory corrected and reindexed." : `Memory ${action}d.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function feedback(record: WarmMemory, signal: "helpful" | "confirmed" | "harmful") {
    setBusy(true);
    try {
      await api.memoryFeedback(scope, record.id, signal);
      setMessage(signal === "confirmed" ? "Memory confirmed as current." : signal === "helpful" ? "Helpful recall recorded." : "Incorrect recall recorded.");
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
    const label = memoryTextRepeats(topic.descriptor.title, topic.descriptor.description) ? topic.descriptor.description : topic.descriptor.title;
    if (!window.confirm(`Forget the Cold topic “${label}”?`))
      return;
    setBusy(true);
    try {
      const result = await api.memoryForget(scope, undefined, [topic.descriptor.topicId]);
      setSelectedTopic(null);
      setMessage("");
      setRecentForget({ ids: [], topicIds: [topic.descriptor.topicId], label, purgeAfter: result.purgeAfter });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function restoreMemory(ids: string[] = [], topicIds: string[] = []) {
    if (!ids.length && !topicIds.length) return;
    setBusy(true);
    setError("");
    try {
      await api.memoryRestore(scope, ids.length ? ids : undefined, topicIds.length ? topicIds : undefined);
      setRecentForget(null);
      setMessage(`Restore requested for ${ids.length + topicIds.length} memory item${ids.length + topicIds.length === 1 ? "" : "s"}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function exportMemory() {
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.memoryExport(scope, 500);
      const url = URL.createObjectURL(new Blob([JSON.stringify({ scope, exportedAt: new Date().toISOString(), ...snapshot }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `tagent-memory-${scope.id.replace(/[^a-z0-9._-]+/gi, "-") || "workspace"}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Memory snapshot exported.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const detailOpen = Boolean(selectedRecord || selectedTopic);
  const hasCatalogData = records.length > 0 || topics.length > 0;
  const hasMemoryData = hasCatalogData || core !== null;
  const catalogHasMatches = filteredRecords.length > 0 || filteredTopics.length > 0 || hasMoreRecords || hasMoreTopics;
  const initialLoading = status === null && busy;

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
          <div>
            <BrainCircuit size={ICON_SIZE.xl} />
            <span><h2>Memory</h2><small data-mono>{status ? memoryStatusSummary(status) : `${scope.id} · ${runtime.memoryBackend ?? "memory"}/${runtime.memoryColdBackend ?? "local"}`}</small></span>
          </div>
          <div className="memory-header-actions">
            <button
              className="icon-button"
              onClick={() => void refresh()}
              aria-label="Refresh memory"
            >
              <RefreshCw size={ICON_SIZE.lg} className={busy ? "spin" : ""} />
            </button>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Close memory center"
            >
              <X size={ICON_SIZE.lg} />
            </button>
          </div>
        </header>
        {hasMemoryData && <div className="memory-toolbar">
          {detailOpen ? <button className="control memory-detail-back" type="button" onClick={() => { setSelectedRecord(null); setSelectedTopic(null); }}><ChevronLeft size={ICON_SIZE.md} />All memory</button> : hasCatalogData && <form
              className="memory-search"
              onSubmit={(event) => {
                event.preventDefault();
                void searchMemory();
              }}
            >
              <Search size={ICON_SIZE.md} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search memory"
                placeholder="Filter loaded catalog…"
              />
              <select value={kind} aria-label="Filter memory kind" onChange={(event) => setKind(event.target.value as "all" | MemoryKind)}>
                {memoryKinds.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
              </select>
              <select value={memoryStatus} aria-label="Filter memory status" onChange={(event) => setMemoryStatus(event.target.value as "all" | MemoryStatus)}>
                {memoryStatuses.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
              </select>
              <button className="control" type="submit">Recall</button>
            </form>}
          <div className="memory-header-actions">
            <button className="control" onClick={() => void exportMemory()} disabled={busy}><Download size={ICON_SIZE.md} />Export</button>
            <button className="control" data-variant="primary" onClick={() => setCaptureOpen(true)}><Plus size={ICON_SIZE.md} />Add memory</button>
          </div>
        </div>}
        <div className="memory-content">
          {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
          {message && <div className="notice" data-tone="success" role="status">{message}</div>}
          {recentForget && <MemoryUndoNotice item={recentForget} busy={busy} onUndo={() => void restoreMemory(recentForget.ids, recentForget.topicIds)} />}
          {detailOpen ? <main className="memory-detail">
            {selectedRecord ? (
              <RecordDetail
                record={selectedRecord}
                onForget={() => void forgetRecord(selectedRecord)}
                onRestore={() => void restoreMemory([selectedRecord.id])}
                onGovern={(action, resolution) => void govern(selectedRecord, action, { resolution })}
                onCorrect={(title, content, reason) => void govern(selectedRecord, "correct", { title, content, reason })}
                onFeedback={(signal) => void feedback(selectedRecord, signal)}
              />
            ) : selectedTopic ? (
              <TopicDetail
                topic={selectedTopic}
                onForget={() => void forgetTopic(selectedTopic)}
                onRestore={() => void restoreMemory([], [selectedTopic.descriptor.topicId])}
              />
            ) : null}
          </main> : <>
            <main className="memory-browser">
            {initialLoading ? <div className="memory-loading" role="status" aria-label="Loading memory"><span /><span /><span /></div> : !hasMemoryData ? <>
              <section className="memory-empty">
                <BrainCircuit size={ICON_SIZE.xl} />
                <strong>No durable memories yet</strong>
                <p>Add a stable fact, preference, event or procedure. Search and filters appear after the first memory is stored.</p>
                <button className="control" data-variant="primary" onClick={() => setCaptureOpen(true)}><Plus size={ICON_SIZE.sm} />Add first memory</button>
              </section>
              <MemoryJobLists reindexJobs={reindexJobs} jobs={jobs} busy={busy} onReindex={() => void runReindex()} onRestore={(ids, topicIds) => void restoreMemory(ids, topicIds)} />
            </> : <>
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
              {catalogHasMatches ? <MemoryCatalog
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
                /> : <section className="memory-empty">
                  <Search size={ICON_SIZE.lg} />
                  <strong>{hasCatalogData ? "No catalog matches" : "No durable memories yet"}</strong>
                  <p>{hasCatalogData ? "Clear the search phrase or choose another memory kind or state." : "Add a stable fact, preference, event or procedure."}</p>
                  <button className="control" onClick={() => {
                    if (hasCatalogData) { setQuery(""); setKind("all"); setMemoryStatus("all"); setResults(null); }
                    else setCaptureOpen(true);
                  }}>{hasCatalogData ? "Clear filters" : "Add first memory"}</button>
                </section>}
              <MemoryCoreProjection
                core={core}
                coreText={coreText}
                onCoreTextChange={setCoreText}
                onGenerate={() => void generateCore()}
                onSave={() => void saveCore()}
              />
              <MemoryJobLists reindexJobs={reindexJobs} jobs={jobs} busy={busy} onReindex={() => void runReindex()} onRestore={(ids, topicIds) => void restoreMemory(ids, topicIds)} />
            </>}
            </main>
          </>}
        </div>
      </section>
      {captureOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCaptureOpen(false);
          }}
        >
          <section className="modal memory-modal" role="dialog" aria-modal="true" aria-labelledby="memory-capture-title">
            <header>
              <div>
                <span className="eyebrow">Policy-gated capture</span>
                <h3 id="memory-capture-title">Add a memory cue</h3>
              </div>
              <button
                className="icon-button"
                onClick={() => setCaptureOpen(false)}
                aria-label="Close add memory"
              >
                <X size={ICON_SIZE.lg} />
              </button>
            </header>
            <section>
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
            </section>
            <footer>
              <span>
                <ShieldCheck size={ICON_SIZE.sm} />
                Scope: {scope.id}
              </span>
              <div>
                <button className="control" onClick={() => setCaptureOpen(false)}>Cancel</button>
                <button
                  className="control"
                  data-variant="primary"
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

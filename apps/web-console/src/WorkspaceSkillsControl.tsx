import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Activity, Check, ChevronDown, Pencil, ShieldCheck, Trash2, Upload, WandSparkles, X } from "lucide-react";
import { api, type SkillRevision, type SkillSummary } from "./api";
import { formatCount } from "./count-format";
import { ICON_SIZE } from "./icon-size";
import { useModalFocus } from "./use-modal-focus";
import { usePopoverFocus } from "./use-popover-focus";
import { WorkspaceSkillAuthority } from "./workspace-skill-authority";

type SkillDraft = Pick<SkillRevision, "name" | "description" | "content" | "disableModelInvocation">;

interface WorkspaceSkillsControlProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBeforeOpen: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function WorkspaceSkillsControl({
  workspaceId,
  open,
  onOpenChange,
  onBeforeOpen,
  onError,
  onNotice,
}: WorkspaceSkillsControlProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [workspaceSkills, setWorkspaceSkills] = useState<SkillRevision[]>([]);
  const [editor, setEditor] = useState<SkillRevision | null>(null);
  const [editorDraft, setEditorDraft] = useState<SkillDraft>({
    name: "",
    description: "",
    content: "",
    disableModelInvocation: false,
  });
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const editorNameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const authorityRef = useRef(new WorkspaceSkillAuthority());
  const refreshGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    authorityRef.current.enterWorkspace(workspaceId);
    setWorkspaceSkills([]);
    setEditor(null);
    setDragActive(false);
  }, [workspaceId]);

  const closeMenu = useCallback(() => {
    setDragActive(false);
    onOpenChange(false);
  }, [onOpenChange]);
  const closeEditor = useCallback(() => setEditor(null), []);
  usePopoverFocus(open, menuRef, closeMenu);
  useModalFocus(Boolean(editor), editorRef, closeEditor, editorNameRef);

  const refresh = useCallback(async (token = authorityRef.current.capture()) => {
    const refreshGeneration = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = refreshGeneration;
    try {
      const [catalog, selected] = await Promise.all([
        api.skills(),
        api.workspaceSkills(token.workspaceId),
      ]);
      if (!mountedRef.current
        || refreshGenerationRef.current !== refreshGeneration
        || !authorityRef.current.isCurrent(token)) return false;
      setSkills(catalog);
      setWorkspaceSkills(selected);
      return true;
    } catch (cause) {
      if (mountedRef.current
        && refreshGenerationRef.current === refreshGeneration
        && authorityRef.current.isCurrent(token)) onError(messageFrom(cause));
      return false;
    }
  }, [onError]);

  useEffect(() => {
    if (!workspaceId) return;
    void refresh(authorityRef.current.capture());
  }, [refresh, workspaceId]);

  const beginMutation = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    onError("");
    return true;
  };

  const finishMutation = () => {
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  };

  const uploadSkill = async (file: File) => {
    if (!beginMutation()) return;
    onNotice("");
    try {
      const uploaded = await api.uploadSkill(file);
      const refreshed = await refresh(authorityRef.current.capture());
      if (refreshed) onNotice(`Skill ${uploaded.name} v${uploaded.revision} added to the shared center.`);
    } catch (cause) {
      if (mountedRef.current) onError(messageFrom(cause));
    } finally {
      finishMutation();
      if (mountedRef.current) {
        setDragActive(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    }
  };

  const toggleWorkspaceSkill = async (skillId: string) => {
    if (!beginMutation()) return;
    const token = authorityRef.current.capture();
    const selectedIds = new Set(workspaceSkills.map((skill) => skill.skillId));
    if (selectedIds.has(skillId)) selectedIds.delete(skillId);
    else selectedIds.add(skillId);
    try {
      const selected = await api.replaceWorkspaceSkills(token.workspaceId, [...selectedIds]);
      if (!mountedRef.current || !authorityRef.current.isCurrent(token)) return;
      setWorkspaceSkills(selected);
      const catalog = await api.skills();
      if (!mountedRef.current || !authorityRef.current.isCurrent(token)) return;
      setSkills(catalog);
      onNotice(selected.length > 0 ? `${formatCount(selected.length, "skill")} referenced by this workspace.` : "Workspace skill references cleared.");
    } catch (cause) {
      if (mountedRef.current && authorityRef.current.isCurrent(token)) onError(messageFrom(cause));
    } finally {
      finishMutation();
    }
  };

  const editSkill = async (skillId: string) => {
    if (!beginMutation()) return;
    const token = authorityRef.current.capture();
    try {
      const revision = await api.skill(skillId);
      if (!mountedRef.current || !authorityRef.current.isCurrent(token)) return;
      setEditor(revision);
      setEditorDraft({
        name: revision.name,
        description: revision.description,
        content: revision.content,
        disableModelInvocation: revision.disableModelInvocation,
      });
    } catch (cause) {
      if (mountedRef.current && authorityRef.current.isCurrent(token)) onError(messageFrom(cause));
    } finally {
      finishMutation();
    }
  };

  const saveSkill = async () => {
    if (!editor || !beginMutation()) return;
    const editedSkillId = editor.skillId;
    try {
      const revision = await api.updateSkill(editedSkillId, editorDraft);
      if (mountedRef.current) setEditor(null);
      const refreshed = await refresh(authorityRef.current.capture());
      if (refreshed) onNotice(`Skill ${revision.name} saved as revision ${revision.revision}.`);
    } catch (cause) {
      if (mountedRef.current) onError(messageFrom(cause));
    } finally {
      finishMutation();
    }
  };

  const removeSkill = async (skill: SkillSummary) => {
    if (busyRef.current || !globalThis.confirm(`Delete ${skill.name} from the shared Skills center? Existing TaskRuns keep their frozen revision.`)) return;
    if (!beginMutation()) return;
    try {
      await api.deleteSkill(skill.id);
      const refreshed = await refresh(authorityRef.current.capture());
      if (refreshed) onNotice(`Skill ${skill.name} deleted from the shared center.`);
    } catch (cause) {
      if (mountedRef.current) onError(messageFrom(cause));
    } finally {
      finishMutation();
    }
  };

  const openSkillPicker = () => {
    setDragActive(false);
    fileRef.current?.click();
  };

  const dropSkill = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void uploadSkill(file);
    else setDragActive(false);
  };

  const toggleMenu = () => {
    if (open) {
      closeMenu();
      return;
    }
    setDragActive(false);
    onBeforeOpen();
    onOpenChange(true);
  };

  return <>
    <div className="skill-control">
      <input ref={fileRef} type="file" accept=".md,.zip,text/markdown,application/zip" hidden onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void uploadSkill(file);
      }} />
      <button
        className={`skill-menu-toggle ${workspaceSkills.length ? "active" : ""} ${dragActive ? "drag-active" : ""}`}
        type="button"
        title="Workspace skills"
        aria-label={workspaceSkills.length > 0 ? `${formatCount(workspaceSkills.length, "skill")} referenced by this workspace` : "No skills referenced by this workspace"}
        aria-haspopup="dialog"
        aria-controls="workspace-skill-menu"
        aria-expanded={open}
        onClick={toggleMenu}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={() => setDragActive(false)}
        onDrop={dropSkill}
      >
        <WandSparkles size={ICON_SIZE.md} />
        <span className="desktop-only">{busy ? "Saving…" : "Skills"}</span>
        {workspaceSkills.length > 0 && <span className="skill-revision-badge">{workspaceSkills.length}</span>}
        <ChevronDown className="desktop-only" size={ICON_SIZE.xs} />
      </button>
      {open && <>
        <button className="workspace-menu-scrim" type="button" aria-label="Close Skill loader" onClick={closeMenu} />
        <div
          id="workspace-skill-menu"
          ref={menuRef}
          className={`skill-loader-menu ${dragActive ? "drag-active" : ""}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby="workspace-skill-heading"
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }}
          onDrop={dropSkill}
        >
          <div className="skill-loader-heading">
            <span className="skill-heading-icon"><WandSparkles size={ICON_SIZE.md} /></span>
            <span><strong id="workspace-skill-heading">Skills center</strong><small>Shared library · choose references for this workspace</small></span>
            {skills.length > 0 && <em>{skills.length}</em>}
          </div>
          <button
            className="skill-drop-target"
            type="button"
            disabled={busy}
            onClick={openSkillPicker}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          >
            <span className="skill-upload-icon">{busy ? <Activity className="spin" size={ICON_SIZE.lg} /> : <Upload size={ICON_SIZE.lg} />}</span>
            <span><strong>{busy ? "Validating Skill…" : "Upload or drop a Skill"}</strong><small>SKILL.md or ZIP · available to every workspace</small></span>
          </button>
          {skills.length > 0 && <div className="skill-catalog">
            <span>Shared Skills</span>
            {skills.map((skill) => {
              const selected = workspaceSkills.some((item) => item.skillId === skill.id);
              return <div className={`skill-catalog-row ${selected ? "selected" : ""}`} key={skill.id}>
                <button type="button" className="skill-reference-toggle" aria-pressed={selected} disabled={busy} onClick={() => void toggleWorkspaceSkill(skill.id)}>
                  <span className="skill-select-box">{selected && <Check size={ICON_SIZE.xs} />}</span>
                  <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                  <em>v{skill.latestRevision}</em>
                </button>
                <div className="skill-row-actions">
                  <button type="button" title="Edit Skill" aria-label={`Edit ${skill.name}`} disabled={busy} onClick={() => void editSkill(skill.id)}><Pencil size={ICON_SIZE.sm} /></button>
                  <button type="button" title="Delete Skill" aria-label={`Delete ${skill.name}`} disabled={busy} onClick={() => void removeSkill(skill)}><Trash2 size={ICON_SIZE.sm} /></button>
                </div>
              </div>;
            })}
          </div>}
          <p className="skill-snapshot-note"><ShieldCheck size={ICON_SIZE.sm} /><span>TaskRuns freeze referenced revisions; later edits or deletions never change running work.</span></p>
        </div>
      </>}
    </div>
    {editor && createPortal(<div className="skill-editor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeEditor();
    }}>
      <section ref={editorRef} className="skill-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-editor-title" aria-describedby="skill-editor-note">
        <header>
          <span><small>Shared Skill</small><h2 id="skill-editor-title">Edit {editor.name}</h2></span>
          <button type="button" aria-label="Close Skill editor" onClick={closeEditor}><X size={ICON_SIZE.lg} /></button>
        </header>
        <div className="skill-editor-grid">
          <label><span>Name</span><input ref={editorNameRef} type="text" autoComplete="off" value={editorDraft.name} onChange={(event) => setEditorDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label><span>Description</span><input type="text" autoComplete="off" value={editorDraft.description} onChange={(event) => setEditorDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="skill-editor-content"><span>Instructions</span><textarea value={editorDraft.content} onChange={(event) => setEditorDraft((current) => ({ ...current, content: event.target.value }))} /></label>
          <label className="skill-editor-option"><input type="checkbox" checked={editorDraft.disableModelInvocation} onChange={(event) => setEditorDraft((current) => ({ ...current, disableModelInvocation: event.target.checked }))} /><span><strong>Manual invocation only</strong><small>Hide this Skill from Pi's available Skills list.</small></span></label>
        </div>
        <footer>
          <span id="skill-editor-note">Saving creates a new immutable revision.</span>
          <div><button type="button" onClick={closeEditor}>Cancel</button><button className="primary" type="button" disabled={busy} onClick={() => void saveSkill()}>{busy ? "Saving…" : "Save revision"}</button></div>
        </footer>
      </section>
    </div>, document.body)}
  </>;
}

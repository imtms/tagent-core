import type { Session } from "./api";

export type WorkspaceEmptyState = {
  kind: "no-workspaces" | "no-matches";
  title: string;
  detail: string;
};

export type WorkspaceNavigationGroup = {
  label: "Pinned" | "Matches" | "Recent";
  workspaces: Session[];
};

export function workspaceEmptyState(totalCount: number, visibleCount: number): WorkspaceEmptyState | null {
  if (totalCount === 0) return {
    kind: "no-workspaces",
    title: "No workspaces yet",
    detail: "Create one to start a task.",
  };
  if (visibleCount === 0) return {
    kind: "no-matches",
    title: "No matching workspaces",
    detail: "Try another name or clear the filter.",
  };
  return null;
}

export function deriveWorkspaceNavigation(
  workspaces: readonly Session[],
  pinnedWorkspaceIds: readonly string[],
  query: string,
): { groups: WorkspaceNavigationGroup[]; emptyState: WorkspaceEmptyState | null } {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleWorkspaces = workspaces.filter((workspace) => !normalizedQuery || workspace.title.toLocaleLowerCase().includes(normalizedQuery));
  const pinnedIds = new Set(pinnedWorkspaceIds);
  const pinnedWorkspaces = visibleWorkspaces.filter((workspace) => pinnedIds.has(workspace.id));
  const recentWorkspaces = visibleWorkspaces.filter((workspace) => !pinnedIds.has(workspace.id));
  return {
    groups: [
      ...(pinnedWorkspaces.length > 0 ? [{ label: "Pinned" as const, workspaces: pinnedWorkspaces }] : []),
      ...(recentWorkspaces.length > 0 ? [{ label: normalizedQuery ? "Matches" as const : "Recent" as const, workspaces: recentWorkspaces }] : []),
    ],
    emptyState: workspaceEmptyState(workspaces.length, visibleWorkspaces.length),
  };
}

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parse } from "yaml";
import type { SkillRevision } from "@tagent/admission/domain";
import type {
  ProfileMutationContext,
  ProfileMutationResult,
  ProfilePageQuery,
  ProfileSkillMutationValue,
  SessionRepository,
  SkillRepository,
} from "@tagent/admission/ports";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_FILES = 128;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SkillUploadInput {
  filename: string;
  contentBase64: string;
}

export interface SkillUpdateInput {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
}

interface ParsedSkill {
  name: string;
  description: string;
  content: string;
  disableModelInvocation: boolean;
}

interface BundleFile { relativePath: string; data: Uint8Array }

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Skill upload is not valid base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`Skill upload exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  return decoded;
}

function safeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe Skill archive path: ${value}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error(`Unsafe Skill archive path: ${value}`);
  return parts.join("/");
}

/** ZIP central directory attributes identify symlinks even though fflate exposes only extracted bytes. */
function assertNoZipSymlinks(data: Uint8Array): void {
  if (data.byteLength < 22) throw new Error("Invalid Skill ZIP central directory");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let endOffset = -1;
  const searchStart = Math.max(0, data.byteLength - 65_557);
  for (let offset = data.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === data.byteLength) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("Invalid Skill ZIP central directory");
  const disk = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff
    || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || directoryOffset + directorySize !== endOffset || entryCount > MAX_FILES) {
    throw new Error("Unsupported or inconsistent Skill ZIP central directory");
  }
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid Skill ZIP central directory entry");
    const externalAttributes = view.getUint32(offset + 38, true);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error("Skill ZIP symlinks are not allowed");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > endOffset) throw new Error("Invalid Skill ZIP central directory entry bounds");
    offset = next;
  }
  if (offset !== endOffset) throw new Error("Invalid Skill ZIP central directory size");
}

function extractBundle(filename: string, bytes: Uint8Array): { files: BundleFile[]; skillPath: string } {
  if (!filename.toLowerCase().endsWith(".zip")) return {
    files: [{ relativePath: "SKILL.md", data: bytes }],
    skillPath: "SKILL.md",
  };
  assertNoZipSymlinks(bytes);
  let count = 0;
  let advertisedBytes = 0;
  const archivePaths = new Set<string>();
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        advertisedBytes += file.originalSize;
        const normalizedPath = safeArchivePath(file.name);
        if (archivePaths.has(normalizedPath)) throw new Error(`Skill ZIP contains a duplicate path: ${file.name}`);
        archivePaths.add(normalizedPath);
        if (count > MAX_FILES) throw new Error(`Skill ZIP exceeds ${MAX_FILES} entries`);
        if (file.originalSize > MAX_FILE_BYTES) throw new Error(`Skill ZIP entry exceeds ${MAX_FILE_BYTES} bytes`);
        if (advertisedBytes > MAX_EXPANDED_BYTES) throw new Error(`Skill ZIP exceeds ${MAX_EXPANDED_BYTES} expanded bytes`);
        return true;
      },
    });
  } catch (error) {
    throw new Error(`Invalid Skill ZIP: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const files = Object.entries(extracted)
    .filter(([name]) => !name.endsWith("/"))
    .map(([name, data]) => ({ relativePath: safeArchivePath(name), data }));
  if (files.some((file) => file.data.byteLength > MAX_FILE_BYTES)
    || files.reduce((total, file) => total + file.data.byteLength, 0) > MAX_EXPANDED_BYTES) {
    throw new Error("Skill ZIP expanded content exceeds the configured bounds");
  }
  const skillPaths = files.filter((file) => path.posix.basename(file.relativePath) === "SKILL.md");
  if (skillPaths.length !== 1) throw new Error("Skill ZIP must contain exactly one SKILL.md");
  const skillPath = skillPaths[0].relativePath;
  const root = path.posix.dirname(skillPath);
  const prefix = root === "." ? "" : `${root}/`;
  const scoped = files
    .filter((file) => file.relativePath === skillPath || file.relativePath.startsWith(prefix))
    .map((file) => ({ ...file, relativePath: prefix ? file.relativePath.slice(prefix.length) : file.relativePath }));
  if (scoped.length !== files.length) throw new Error("Skill ZIP files must all be inside the directory containing SKILL.md");
  return { files: scoped, skillPath: "SKILL.md" };
}

function parseSkill(data: Uint8Array): ParsedSkill {
  if (data.byteLength > MAX_SKILL_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`);
  let source: string;
  try { source = decoder.decode(data).replace(/\r\n?/g, "\n"); }
  catch { throw new Error("SKILL.md must be valid UTF-8"); }
  if (!source.startsWith("---\n")) throw new Error("SKILL.md requires YAML frontmatter");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  let frontmatter: unknown;
  try { frontmatter = parse(source.slice(4, end)); }
  catch (error) { throw new Error(`Invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error("SKILL.md frontmatter must be a mapping");
  const metadata = frontmatter as Record<string, unknown>;
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Skill name must be 1-64 lowercase letters, digits, or single hyphens");
  }
  if (!description || description.length > 1024) throw new Error("Skill description must be 1-1024 characters");
  if (metadata["disable-model-invocation"] !== undefined && typeof metadata["disable-model-invocation"] !== "boolean") {
    throw new Error("disable-model-invocation must be boolean");
  }
  const content = source.slice(end + 5).trim();
  if (!content) throw new Error("SKILL.md instruction body is required");
  return { name, description, content, disableModelInvocation: metadata["disable-model-invocation"] === true };
}

function bundleHash(files: BundleFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath).update("\0").update(file.data).update("\0");
  }
  return hash.digest("hex");
}

function editorSkillFile(input: SkillUpdateInput): BundleFile {
  const name = input.name.trim();
  const description = input.description.trim();
  const content = input.content.replace(/\r\n?/g, "\n").trim();
  const source = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ndisable-model-invocation: ${Boolean(input.disableModelInvocation)}\n---\n\n${content}\n`;
  const data = new TextEncoder().encode(source);
  parseSkill(data);
  return { relativePath: "SKILL.md", data };
}

async function requireDirectory(pathname: string): Promise<void> {
  const info = await lstat(pathname);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${pathname} must be a real directory, not a symlink`);
}

async function assertExistingBundle(target: string, managedRoot: string, files: BundleFile[]): Promise<void> {
  await requireDirectory(target);
  const canonicalTarget = await realpath(target);
  const canonicalManagedRoot = await realpath(managedRoot);
  if (!canonicalTarget.startsWith(`${canonicalManagedRoot}${path.sep}`)) throw new Error("Existing Skill revision escapes managed storage");
  const expected = new Set(files.map((file) => file.relativePath));
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      const relative = path.relative(target, pathname).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("Existing Skill revision contains an unsafe symlink");
      if (entry.isDirectory()) { pending.push(pathname); continue; }
      if (!entry.isFile() || !expected.has(relative)) throw new Error("Existing Skill revision contains unexpected content");
    }
  }
  for (const file of files) {
    const existingPath = path.join(target, ...file.relativePath.split("/"));
    const info = await lstat(existingPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Existing Skill revision contains an unsafe file");
    const existing = await readFile(existingPath);
    if (!existing.equals(Buffer.from(file.data))) throw new Error("Existing Skill revision does not match its content hash");
  }
}


async function readManagedBundle(filePath: string, workspace: string, managedRoot: string): Promise<BundleFile[]> {
  const root = path.dirname(path.join(workspace, ...filePath.split("/")));
  await requireDirectory(root);
  const canonicalRoot = await realpath(root);
  const canonicalManagedRoot = await realpath(managedRoot);
  if (!canonicalRoot.startsWith(`${canonicalManagedRoot}${path.sep}`)) throw new Error("Skill revision escapes managed storage");
  const files: BundleFile[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Skill revision contains an unsafe symlink");
      if (entry.isDirectory()) { pending.push(pathname); continue; }
      if (!entry.isFile()) throw new Error("Skill revision contains an unsupported entry");
      const data = new Uint8Array(await readFile(pathname));
      if (data.byteLength > MAX_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_FILE_BYTES} bytes`);
      files.push({ relativePath: path.relative(root, pathname).split(path.sep).join("/"), data });
    }
  }
  if (files.length > MAX_FILES || files.reduce((total, file) => total + file.data.byteLength, 0) > MAX_EXPANDED_BYTES) {
    throw new Error("Skill bundle exceeds the configured bounds");
  }
  return files;
}

export class CoreSkillApplication {
  private readonly workspace: string;
  constructor(
    private readonly skills: SkillRepository,
    private readonly sessions: Pick<SessionRepository, "getSession">,
    workspace: string,
  ) { this.workspace = path.resolve(workspace); }

  listSkills() { return this.skills.listSkills(); }
  listSkillsProfile(query: ProfilePageQuery) { return this.skills.listProfileSkillsPage(query); }
  getSkill(skillId: string) {
    const skill = this.skills.getSkill(skillId);
    if (!skill) throw new Error("Skill not found");
    return skill;
  }
  getSkillProfile(skillId: string) {
    const skill = this.getSkill(skillId);
    return {
      skill,
      resourceRevision: this.skills.getSkillResourceRevision(skillId)!,
      catalogRevision: this.skills.getCatalogRevision(),
    };
  }
  listSkillRevisions(skillId: string) {
    if (!this.skills.getSkill(skillId)) throw new Error("Skill not found");
    return this.skills.listRevisions(skillId);
  }
  listSkillRevisionsProfile(skillId: string, query: ProfilePageQuery) {
    const page = this.skills.listProfileSkillRevisionsPage(skillId, query);
    if (!page) throw new Error("Skill not found");
    return page;
  }
  listWorkspaceSkills(workspaceId: string) {
    if (!this.sessions.getSession(workspaceId)) throw new Error("Session not found");
    return this.skills.listWorkspaceSkills(workspaceId);
  }
  listWorkspaceSkillsProfile(workspaceId: string, query: ProfilePageQuery) {
    const page = this.skills.listProfileWorkspaceSkillsPage(workspaceId, query);
    if (!page) throw new Error("Session not found");
    return page;
  }
  replaceWorkspaceSkills(workspaceId: string, skillIds: readonly string[]) {
    if (!this.sessions.getSession(workspaceId)) throw new Error("Session not found");
    if (skillIds.length > 32) throw new Error("A Workspace can reference at most 32 Skills");
    const selected = this.skills.replaceWorkspaceSkills(workspaceId, skillIds);
    if (!selected) throw new Error("Skill not found");
    return selected;
  }
  replaceWorkspaceSkillsProfile(workspaceId: string, skillIds: readonly string[], mutation: ProfileMutationContext) {
    if (skillIds.length > 32) throw new Error("A Workspace can reference at most 32 Skills");
    return this.skills.replaceWorkspaceSkillsProfile(workspaceId, skillIds, mutation);
  }

  private persistBundle(
    parsed: ParsedSkill,
    bundle: { files: BundleFile[] },
    sourceFilename: string,
    skillId?: string,
  ): Promise<SkillRevision>;
  private persistBundle(
    parsed: ParsedSkill,
    bundle: { files: BundleFile[] },
    sourceFilename: string,
    skillId: string | undefined,
    mutation: ProfileMutationContext,
  ): Promise<ProfileMutationResult<ProfileSkillMutationValue>>;
  private async persistBundle(
    parsed: ParsedSkill,
    bundle: { files: BundleFile[] },
    sourceFilename: string,
    skillId?: string,
    mutation?: ProfileMutationContext,
  ): Promise<SkillRevision | ProfileMutationResult<ProfileSkillMutationValue>> {
    const sha256 = bundleHash(bundle.files);
    const tagentRoot = path.join(this.workspace, ".tagent");
    const managedRoot = path.join(tagentRoot, "skills");
    await mkdir(this.workspace, { recursive: true });
    await requireDirectory(this.workspace);
    await mkdir(tagentRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await requireDirectory(tagentRoot);
    await mkdir(managedRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await requireDirectory(managedRoot);
    const canonicalWorkspace = await realpath(this.workspace);
    const canonicalManagedRoot = await realpath(managedRoot);
    if (canonicalManagedRoot !== canonicalWorkspace && !canonicalManagedRoot.startsWith(`${canonicalWorkspace}${path.sep}`)) {
      throw new Error("Managed Skill directory escapes the workspace");
    }
    const relativeDirectory = path.join(".tagent", "skills", parsed.name, sha256);
    const target = path.join(this.workspace, relativeDirectory);
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    await requireDirectory(parent);
    const staging = await mkdtemp(path.join(managedRoot, ".upload-"));
    try {
      for (const file of bundle.files) {
        const destination = path.join(staging, ...file.relativePath.split("/"));
        const relative = path.relative(staging, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe Skill file path: ${file.relativePath}`);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.data, { flag: "wx" });
      }
      try { await rename(staging, target); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await assertExistingBundle(target, managedRoot, bundle.files);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const input = {
      skillId,
      ...parsed,
      filePath: path.posix.join(...relativeDirectory.split(path.sep), "SKILL.md"),
      sha256,
      sourceFilename,
    };
    return mutation
      ? this.skills.createRevisionProfile(input, mutation)
      : this.skills.createRevision(input);
  }

  async uploadSkill(input: SkillUploadInput) {
    const filename = path.basename(input.filename.trim());
    if (!filename || filename.length > 255 || (!filename.toLowerCase().endsWith(".zip") && !filename.toLowerCase().endsWith(".md"))) {
      throw new Error("Upload a SKILL.md or .zip Skill bundle");
    }
    const bundle = extractBundle(filename, decodeBase64(input.contentBase64));
    const parsed = parseSkill(bundle.files.find((file) => file.relativePath === bundle.skillPath)!.data);
    return this.persistBundle(parsed, bundle, filename);
  }

  async uploadSkillProfile(input: SkillUploadInput, mutation: ProfileMutationContext) {
    const filename = path.basename(input.filename.trim());
    if (!filename || filename.length > 255 || (!filename.toLowerCase().endsWith(".zip") && !filename.toLowerCase().endsWith(".md"))) {
      throw new Error("Upload a SKILL.md or .zip Skill bundle");
    }
    const bundle = extractBundle(filename, decodeBase64(input.contentBase64));
    const parsed = parseSkill(bundle.files.find((file) => file.relativePath === bundle.skillPath)!.data);
    return this.persistBundle(parsed, bundle, filename, undefined, mutation);
  }

  async updateSkill(skillId: string, input: SkillUpdateInput) {
    const current = this.getSkill(skillId);
    const edited = editorSkillFile(input);
    const parsed = parseSkill(edited.data);
    const duplicateName = this.skills.listSkills().find((skill) => skill.id !== skillId && skill.name === parsed.name);
    if (duplicateName) throw new Error(`Skill name ${parsed.name} already exists`);
    const managedRoot = path.join(this.workspace, ".tagent", "skills");
    const files = await readManagedBundle(current.filePath, this.workspace, managedRoot);
    const nextFiles = files.filter((file) => file.relativePath !== "SKILL.md");
    nextFiles.push(edited);
    return this.persistBundle(parsed, { files: nextFiles }, "web-editor", skillId);
  }

  async updateSkillProfile(skillId: string, input: SkillUpdateInput, mutation: ProfileMutationContext) {
    const current = this.getSkill(skillId);
    const edited = editorSkillFile(input);
    const parsed = parseSkill(edited.data);
    const duplicateName = this.skills.listSkills().find((skill) => skill.id !== skillId && skill.name === parsed.name);
    if (duplicateName) throw new Error(`Skill name ${parsed.name} already exists`);
    const managedRoot = path.join(this.workspace, ".tagent", "skills");
    const files = await readManagedBundle(current.filePath, this.workspace, managedRoot);
    const nextFiles = files.filter((file) => file.relativePath !== "SKILL.md");
    nextFiles.push(edited);
    return this.persistBundle(parsed, { files: nextFiles }, "profile-editor", skillId, mutation);
  }

  deleteSkill(skillId: string) {
    const deleted = this.skills.deleteSkill(skillId);
    if (!deleted) throw new Error("Skill not found");
    // Immutable content-addressed bundles remain available to historical and active TaskRuns.
    return { ok: true as const };
  }

  deleteSkillProfile(skillId: string, mutation: ProfileMutationContext) {
    return this.skills.deleteSkillProfile(skillId, mutation);
  }
}

/* global console */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(".agents/notes");
const statuses = new Set(["proposed", "implemented", "rejected"]);
const kinds = new Set(["architecture", "process", "testing", "feature", "bug-fix", "simplification"]);
const sections = {
  proposed: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"],
  implemented: ["Problem", "Decision", "Alternatives considered", "Verification", "Consequences"],
  rejected: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks", "Rejection rationale"],
};
const errors = [];
let checked = 0;

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name === "README.md") continue;
  if (!entry.isDirectory() || !statuses.has(entry.name)) {
    errors.push(`unknown decision-tree entry: .agents/notes/${entry.name}`);
    continue;
  }
  const status = entry.name;
  for (const note of await readdir(path.join(root, status), { withFileTypes: true })) {
    const relative = `.agents/notes/${status}/${note.name}`;
    if (!note.isFile() || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(note.name)) {
      errors.push(`${relative}: expected a YYYY-MM-DD-kebab-case.md file`);
      continue;
    }
    checked += 1;
    const source = await readFile(path.join(root, status, note.name), "utf8");
    const lines = source.split(/\r?\n/);
    if (!/^# Decision: \S/.test(lines[0] ?? "") || lines[1] !== ""
      || lines[2] !== `Status: ${status}` || !/^Kind: \S+$/.test(lines[3] ?? "") || lines[4] !== "") {
      errors.push(`${relative}: invalid five-line header block`);
    }
    const kind = (lines[3] ?? "").slice("Kind: ".length);
    if (!kinds.has(kind)) errors.push(`${relative}: unknown Kind '${kind}'`);
    const actualSections = lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
    const required = sections[status];
    if (JSON.stringify(actualSections) !== JSON.stringify(required)) {
      errors.push(`${relative}: sections must be exactly ${required.map((name) => `## ${name}`).join(", ")}`);
    }
    for (const name of required) {
      const start = lines.indexOf(`## ${name}`);
      const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
      const body = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
      if (!body) errors.push(`${relative}: ## ${name} cannot be empty`);
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`verify-agent-notes: ${checked} decision record(s) conform`);
}

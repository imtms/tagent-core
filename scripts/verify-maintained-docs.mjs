import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { isPathInside } from "./path-containment.mjs";

const repositoryRoot = process.cwd();
const docsRoot = resolve(repositoryRoot, "docs");
const docsIndex = resolve(docsRoot, "README.md");
const maintainedDocs = readdirSync(docsRoot)
  .filter((name) => name.endsWith(".md"))
  .map((name) => resolve(docsRoot, name));
const linkedRoots = [
  resolve(repositoryRoot, "README.md"),
  resolve(repositoryRoot, "CONTRIBUTING.md"),
  resolve(repositoryRoot, "SECURITY.md"),
  resolve(repositoryRoot, "CHANGELOG.md"),
  ...maintainedDocs,
];

function localMarkdownTargets(filename) {
  const source = readFileSync(filename, "utf8");
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().split(/\s+["']/)[0])
    .map((target) => target.replace(/^<|>$/g, ""))
    .filter((target) => target && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => target.split("#")[0])
    .map((target) => {
      try {
        return decodeURIComponent(target);
      } catch {
        throw new Error(`${relative(repositoryRoot, filename)} contains an invalid encoded link: ${target}`);
      }
    });
}

const missingLinks = linkedRoots.flatMap((filename) => localMarkdownTargets(filename)
  .map((target) => ({ filename, target, resolved: resolve(dirname(filename), target) }))
  .filter(({ resolved }) => !existsSync(resolved)));

if (missingLinks.length) {
  throw new Error(`Missing maintained documentation links:\n${missingLinks
    .map(({ filename, target }) => `- ${relative(repositoryRoot, filename)} -> ${target}`)
    .join("\n")}`);
}

const indexedTargets = localMarkdownTargets(docsIndex)
  .map((target) => resolve(docsRoot, target))
  .filter((target) => isPathInside(docsRoot, target) && target.endsWith(".md") && target !== docsIndex);
const duplicateTargets = [...new Set(indexedTargets.filter((target, index) => indexedTargets.indexOf(target) !== index))];
if (duplicateTargets.length) {
  throw new Error(`Duplicate maintained documentation index entries: ${duplicateTargets.map((target) => relative(repositoryRoot, target)).join(", ")}`);
}

const indexedSet = new Set(indexedTargets);
const unindexedDocs = maintainedDocs.filter((filename) => filename !== docsIndex && !indexedSet.has(filename));
if (unindexedDocs.length) {
  throw new Error(`Unindexed maintained documentation: ${unindexedDocs.map((filename) => relative(repositoryRoot, filename)).join(", ")}`);
}

process.stdout.write(`verify-maintained-docs: ${maintainedDocs.length - 1} maintained document(s) indexed once with valid local links\n`);

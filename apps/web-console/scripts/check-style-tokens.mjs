import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import postcss from "postcss";
import ts from "typescript";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = path.join(projectRoot, "src");
const cssPath = path.join(srcRoot, "app.css");
const indexPath = path.join(projectRoot, "index.html");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

function declarations(rule) {
  const values = new Map();
  rule.walkDecls((declaration) => values.set(declaration.prop, declaration.value));
  return values;
}

function ruleHasDeclaration(root, selector, property, value, media = "") {
  let found = false;
  root.walkRules((rule) => {
    if (!rule.selectors?.includes(selector)) return;
    if (media) {
      let ancestor = rule.parent;
      let matches = false;
      while (ancestor && ancestor.type !== "root") {
        if (ancestor.type === "atrule" && ancestor.name === "media" && ancestor.params === media) matches = true;
        ancestor = ancestor.parent;
      }
      if (!matches) return;
    }
    rule.walkDecls(property, (declaration) => {
      if (declaration.value === value) found = true;
    });
  });
  return found;
}

for (const legacy of ["cascade.css", "layout.css", "design-system.css", "goal-styles.css", "styles.css"]) {
  check(!fs.existsSync(path.join(srcRoot, legacy)), `src/${legacy} is retired; keep one canonical stylesheet`);
}
check(fs.existsSync(cssPath), "src/app.css must exist");

const sourceFiles = filesUnder(srcRoot);
const cssFiles = sourceFiles.filter((file) => file.endsWith(".css"));
check(cssFiles.length === 1 && cssFiles[0] === cssPath, "src/app.css must be the only component stylesheet");

const scriptFiles = sourceFiles.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
const cssImports = [];
for (const file of scriptFiles) {
  const source = read(file);
  const importPattern = /\bimport\s*(?:[^"']*?\sfrom\s*)?["']([^"']+\.css)["']/g;
  for (const match of source.matchAll(importPattern)) cssImports.push([path.relative(projectRoot, file), match[1]]);
}
check(cssImports.length === 1 && cssImports[0][0] === "src/main.tsx" && cssImports[0][1] === "./app.css", "src/main.tsx must be the only CSS importer and must import ./app.css");

const css = read(cssPath);
const root = postcss.parse(css, { from: cssPath });
const cssClassNames = new Set();
root.walkRules((rule) => {
  for (const selector of rule.selectors ?? []) {
    for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) cssClassNames.add(match[1]);
  }
});

function addClassTokens(value, file, position, target) {
  for (const token of value.trim().split(/\s+/).filter(Boolean)) {
    if (/^[A-Za-z_][\w-]*$/.test(token) && !target.has(token)) target.set(token, [file, position]);
  }
}

function collectClassValue(node, sourceFile, file, target) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  if (ts.isStringLiteralLike(node)) {
    addClassTokens(node.text, file, position, target);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    addClassTokens(node.head.text, file, position, target);
    for (const span of node.templateSpans) {
      collectClassValue(span.expression, sourceFile, file, target);
      addClassTokens(span.literal.text, file, position, target);
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectClassValue(node.whenTrue, sourceFile, file, target);
    collectClassValue(node.whenFalse, sourceFile, file, target);
    return;
  }
  if (ts.isParenthesizedExpression(node)) collectClassValue(node.expression, sourceFile, file, target);
}

const jsxClassNames = new Map();
for (const file of scriptFiles.filter((candidate) => candidate.endsWith(".tsx"))) {
  const source = read(file);
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relativeFile = path.relative(projectRoot, file);
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.text === "className" && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) collectClassValue(node.initializer, sourceFile, relativeFile, jsxClassNames);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) collectClassValue(node.initializer.expression, sourceFile, relativeFile, jsxClassNames);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
for (const [className, [file, line]] of jsxClassNames) {
  check(cssClassNames.has(className), `${file}:${line} uses unstyled class .${className}; remove it or make it part of the canonical visual system`);
}
for (const className of cssClassNames) {
  check(jsxClassNames.has(className), `app.css styles unused class .${className}; delete the dead selector`);
}

const lineCount = css.split("\n").length;
let ruleCount = 0;
const selectors = new Set();
let declarationCount = 0;
root.walkRules((rule) => {
  ruleCount += 1;
  for (const selector of rule.selectors ?? [rule.selector]) selectors.add(selector);
});
root.walkDecls(() => { declarationCount += 1; });
const selectorCount = selectors.size;
check(lineCount <= 800, `app.css has ${lineCount} lines; keep the canonical stylesheet below 800`);
check(ruleCount <= 420, `app.css has ${ruleCount} rules; keep the rule system below 420`);
check(selectorCount <= 500, `app.css has ${selectorCount} selectors; keep the selector system below 500`);
check(declarationCount <= 1450, `app.css has ${declarationCount} declarations; keep the visual system below 1450`);

const lightRule = root.nodes.find((node) => node.type === "rule" && node.selector === ":root");
const darkRule = root.nodes.find((node) => node.type === "rule" && node.selector === ':root[data-theme="dark"]');
check(Boolean(lightRule), "app.css must define light tokens in :root");
check(Boolean(darkRule), "app.css must define dark tokens in :root[data-theme=\"dark\"]");
const lightTokens = lightRule ? declarations(lightRule) : new Map();
const darkTokens = darkRule ? declarations(darkRule) : new Map();

const fixedTokens = new Map([
  ["--text-xs", "0.75rem"],
  ["--text-sm", "0.8125rem"],
  ["--text-md", "0.875rem"],
  ["--text-lg", "1rem"],
  ["--text-xl", "1.25rem"],
  ["--space-1", "4px"],
  ["--space-2", "8px"],
  ["--space-3", "12px"],
  ["--space-4", "16px"],
  ["--space-6", "24px"],
  ["--space-8", "32px"],
  ["--space-12", "48px"],
  ["--control", "36px"],
  ["--touch", "44px"],
  ["--radius-sm", "6px"],
  ["--radius", "10px"],
  ["--radius-lg", "16px"],
  ["--radius-pill", "999px"],
  ["--sidebar-width", "280px"],
  ["--bar-height", "52px"],
  ["--content-width", "820px"],
  ["--drawer-width", "400px"],
]);
for (const [token, value] of fixedTokens) check(lightTokens.get(token) === value, `${token} must remain ${value}`);

const allowedScaleTokens = new Set(fixedTokens.keys());
for (const token of lightTokens.keys()) {
  if (/^--(?:space-|radius|text-(?:xs|sm|md|lg|xl)|control$|touch$|sidebar-width$|bar-height$|content-width$|drawer-width$)/.test(token)) {
    check(allowedScaleTokens.has(token), `${token} is outside the intentionally small geometry/type scales`);
  }
}

const rawColor = /(?:#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\()/i;
root.walkDecls((declaration) => {
  if (!rawColor.test(declaration.value)) return;
  const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
  check(selector === ":root" || selector === ':root[data-theme="dark"]', `${path.basename(cssPath)}:${declaration.source.start.line} raw colors belong only in theme token blocks`);
});

root.walkDecls((declaration) => {
  if (!declaration.important) return;
  const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
  let ancestor = declaration.parent;
  let reducedMotion = false;
  while (ancestor && ancestor.type !== "root") {
    if (ancestor.type === "atrule" && ancestor.name === "media" && ancestor.params.includes("prefers-reduced-motion")) reducedMotion = true;
    ancestor = ancestor.parent;
  }
  check(selector === ".sr-only" || reducedMotion, `${path.basename(cssPath)}:${declaration.source.start.line} !important is reserved for sr-only and reduced motion`);
});

root.walkAtRules("import", (rule) => failures.push(`${path.basename(cssPath)}:${rule.source.start.line} must not import another stylesheet`));
check(!css.includes("backdrop-filter"), "Opaque overlays are required; backdrop-filter is not allowed");

const seenDeclarations = new Map();
root.walkRules((rule) => {
  const contexts = [];
  let ancestor = rule.parent;
  while (ancestor && ancestor.type !== "root") {
    if (ancestor.type === "atrule") contexts.unshift(`@${ancestor.name} ${ancestor.params}`);
    ancestor = ancestor.parent;
  }
  rule.walkDecls((declaration) => {
    const key = `${contexts.join("|")}|${rule.selector}|${declaration.prop}`;
    const previous = seenDeclarations.get(key);
    check(previous === undefined, `${path.basename(cssPath)}:${declaration.source.start.line} duplicates ${declaration.prop} for ${rule.selector} (first at ${previous})`);
    if (previous === undefined) seenDeclarations.set(key, declaration.source.start.line);
  });
});

const uiSource = [css, ...scriptFiles.map(read)].join("\n");
for (const retired of [
  "workspace-kicker", "composer-toolbar", "left-collapsed", "right-collapsed", "collapsed-workspace-tooltip", "collapsed-audit",
  "gate-profile-control", "memory-summary", "memory-kind-filter", "memory-record-list", "topic-grid", "recall-grid",
  "memory-job-row", "goal-section-card", "goal-progress-card", "goal-editor-section", "goal-disclosure",
]) {
  check(!uiSource.includes(retired), `${retired} is retired; do not restore the old multi-column/collapsed UI`);
}

const statusRules = [
  ['[data-tone="accent"]', "color", "var(--accent)"],
  ['[data-tone="info"]', "color", "var(--info)"],
  ['[data-tone="success"]', "color", "var(--success)"],
  ['[data-tone="warning"]', "color", "var(--warning)"],
  ['[data-tone="danger"]', "color", "var(--danger)"],
];
for (const [selector, property, value] of statusRules) check(ruleHasDeclaration(root, selector, property, value), `${selector} must map ${property} to ${value}`);

check(ruleHasDeclaration(root, ".icon-button", "width", "var(--touch)", "(max-width: 680px)"), "Mobile icon buttons must use the 44px touch target");
check(ruleHasDeclaration(root, ".composer-send", "height", "var(--touch)", "(max-width: 680px)"), "Mobile send must use the 44px touch target");

const index = read(indexPath);
const styleMatch = index.match(/<style>([\s\S]*?)<\/style>/);
check(Boolean(styleMatch), "index.html must keep an inline first-paint style");
if (styleMatch) {
  const bootRoot = postcss.parse(styleMatch[1], { from: indexPath });
  const bootLightRule = bootRoot.nodes.find((node) => node.type === "rule" && node.selector === ":root");
  const bootDarkRule = bootRoot.nodes.find((node) => node.type === "rule" && node.selector === ':root[data-theme="dark"]');
  const bootLight = bootLightRule ? declarations(bootLightRule) : new Map();
  const bootDark = bootDarkRule ? declarations(bootDarkRule) : new Map();
  const bootMap = new Map([
    ["--boot-surface", "--surface"],
    ["--boot-muted", "--sidebar"],
    ["--boot-raised", "--surface"],
    ["--boot-line", "--border"],
    ["--boot-ink", "--text"],
    ["--boot-copy", "--text-muted"],
    ["--boot-mark-bg", "--text"],
    ["--boot-mark-fg", "--surface"],
  ]);
  for (const [bootToken, appToken] of bootMap) {
    check(bootLight.get(bootToken) === lightTokens.get(appToken), `${bootToken} must match light ${appToken}`);
    check(bootDark.get(bootToken) === darkTokens.get(appToken), `${bootToken} must match dark ${appToken}`);
  }
  check(index.includes("grid-template-columns: 280px minmax(0, 1fr)"), "Boot shell must match the 280px Workspace sidebar");
  check(index.includes(".boot-topbar { height: 52px"), "Boot shell must match the 52px application bar");
}

if (failures.length) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Web style contract passed: ${lineCount} lines, ${ruleCount} rules, ${selectorCount} selectors, ${declarationCount} declarations.\n`);
}

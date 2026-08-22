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
check(!lightTokens.has("--hover") && !darkTokens.has("--hover"), "Ordinary hover feedback must reuse --muted instead of adding a near-duplicate neutral token");

function resolvedToken(tokens, name, seen = new Set()) {
  const value = tokens.get(name);
  if (!value || seen.has(name)) return "";
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return reference ? resolvedToken(tokens, reference, new Set([...seen, name])) : value;
}

function oklchLuminance(value) {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!match) return undefined;
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]) * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = Math.max(0, Math.min(1, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const green = Math.max(0, Math.min(1, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = Math.max(0, Math.min(1, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left, right) {
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const [theme, tokens] of [["light", lightTokens], ["dark", darkTokens]]) {
  const surface = oklchLuminance(resolvedToken(tokens, "--surface"));
  check(surface !== undefined, `${theme} --surface must be an OKLCH color`);
  if (surface === undefined) continue;
  for (const token of ["--text", "--text-muted", "--accent", "--warning", "--danger"]) {
    const luminance = oklchLuminance(resolvedToken(tokens, token));
    check(luminance !== undefined, `${theme} ${token} must resolve to an OKLCH color`);
    if (luminance !== undefined) check(contrastRatio(luminance, surface) >= 4.5, `${theme} ${token} must retain 4.5:1 contrast on --surface`);
  }
  const accent = oklchLuminance(resolvedToken(tokens, "--accent"));
  const accentContrast = oklchLuminance(resolvedToken(tokens, "--accent-contrast"));
  if (accent !== undefined && accentContrast !== undefined) check(contrastRatio(accent, accentContrast) >= 4.5, `${theme} --accent-contrast must retain 4.5:1 contrast on --accent`);
}

const fixedTokens = new Map([
  ["--text-2xs", "0.625rem"],
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
  ["--icon-slot", "20px"],
  ["--meta-row", "22px"],
  ["--compact", "28px"],
  ["--status-dot", "6px"],
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
  ["--duration-fast", "120ms"],
  ["--duration-base", "180ms"],
  ["--duration-pulse", "1.4s"],
]);
for (const [token, value] of fixedTokens) check(lightTokens.get(token) === value, `${token} must remain ${value}`);

const allowedScaleTokens = new Set(fixedTokens.keys());
for (const token of lightTokens.keys()) {
  if (/^--(?:space-|radius|text-(?:2xs|xs|sm|md|lg|xl)|icon-slot$|meta-row$|compact$|status-dot$|control$|touch$|sidebar-width$|bar-height$|content-width$|drawer-width$)/.test(token)) {
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

const allowedOutlineResets = new Set([
  ".workspace-title-input",
  ".composer textarea",
  ":is(.workspace-switcher-search input, .memory-search input, .memory-search select)",
]);
root.walkDecls("outline", (declaration) => {
  if (!/^(?:0|none)$/.test(declaration.value)) return;
  const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
  check(allowedOutlineResets.has(selector), `${path.basename(cssPath)}:${declaration.source.start.line} ${selector} may not cancel the shared focus-visible outline`);
});

for (const selector of [".workspace-more", ".message-copy"]) {
  root.walkRules((rule) => {
    if (!rule.selector.includes(selector)) return;
    rule.walkDecls("opacity", (declaration) => failures.push(`${path.basename(cssPath)}:${declaration.source.start.line} ${selector} must use the contrast-tested muted color without extra opacity`));
  });
}
root.walkDecls("opacity", (declaration) => {
  const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
  check(!selector.includes(":disabled"), `${path.basename(cssPath)}:${declaration.source.start.line} disabled controls must use explicit muted tokens instead of compounded opacity`);
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
  "active-run-strip", "RunActivityStrip", "workspace-run-status", "memory-job-state", "phase-badge", "goal-status-badge",
]) {
  check(!uiSource.includes(retired), `${retired} is retired; do not restore the old multi-column/collapsed UI`);
}
for (const retiredClass of [
  "memory-center", "memory-header", "memory-header-actions", "memory-disclosure", "memory-disclosure-body", "memory-empty", "memory-inline-actions", "goal-field", "goal-form-columns",
]) {
  check(!cssClassNames.has(retiredClass) && !jsxClassNames.has(retiredClass), `.${retiredClass} is retired; use the shared structural class instead of borrowing another feature's name`);
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
check(ruleHasDeclaration(root, ":is(button, input, textarea, select):disabled", "color", "var(--text-muted)"), "Disabled controls must remain legible through the shared muted text token");
check(ruleHasDeclaration(root, ":is(.control, .icon-button, .composer-send, input, textarea, select):disabled", "background", "var(--muted)"), "Disabled fields and bounded controls must use the shared muted surface");
check(ruleHasDeclaration(root, ".control", "min-height", "var(--touch)", "(max-width: 680px)"), "Mobile controls must use the shared 44px touch target");
check(ruleHasDeclaration(root, ":is(input:not([type=\"checkbox\"]), textarea, select)", "min-height", "var(--touch)", "(max-width: 680px)"), "Mobile fields must use the shared 44px touch target");
check(ruleHasDeclaration(root, ".composer-send", "height", "var(--touch)", "(max-width: 680px)"), "Mobile send must use the 44px touch target");
check(ruleHasDeclaration(root, ".run-metrics", "grid-template-columns", "repeat(2, minmax(0, 1fr))", "(max-width: 680px)"), "Mobile Run metrics must retain readable numeric columns");
check(ruleHasDeclaration(root, ".tool-call-body", "grid-template-columns", "minmax(0, 1fr)"), "Tool call bodies must constrain intrinsic content to the available column");
check(ruleHasDeclaration(root, ".tool-call-body > div", "min-width", "0"), "Tool call sections must allow long content to shrink before its preformatted child scrolls");
check(ruleHasDeclaration(root, ".status-label", "display", "inline-flex"), "Operational states must share the compact dot-and-label grammar");
check(ruleHasDeclaration(root, ".status-dot", "width", "var(--status-dot)"), "Operational status dots must use the shared indicator size");
check(ruleHasDeclaration(root, ".meta-line", "display", "flex"), "Metadata rows must share one flex alignment grammar");
check(ruleHasDeclaration(root, ".truncate", "text-overflow", "ellipsis"), "Shrinkable labels must share one truncation grammar");
check(ruleHasDeclaration(root, ".run-status-control", "height", "var(--compact)"), "Compact status controls must use the shared compact height");
check(ruleHasDeclaration(root, ".message-feed", "width", "min(100%, calc(var(--content-width) + var(--space-12)))"), "Conversation padding must preserve the shared content-width alignment");
check(ruleHasDeclaration(root, ".topbar", "min-width", "0"), "The application bar must shrink inside the conversation grid at narrow widths");
check(ruleHasDeclaration(root, ".workspace-heading h1", "width", "100%", "(max-width: 980px)"), "Narrow Workspace headings must fit their allocated application-bar track");
check(ruleHasDeclaration(root, ".workspace-heading h1 button", "width", "100%", "(max-width: 980px)"), "Narrow Workspace title controls must truncate inside their heading track");
check(ruleHasDeclaration(root, ".workspace-heading h1 button", "min-height", "var(--touch)", "(max-width: 680px)"), "Mobile Workspace title controls must use the shared touch target");
check(ruleHasDeclaration(root, ".notice", "overflow-wrap", "anywhere"), "Feedback notices must wrap generated messages inside their boundary");
check(ruleHasDeclaration(root, ".notice > :first-child", "min-width", "0"), "Feedback copy must shrink before its action");
check(ruleHasDeclaration(root, ".notice > .control", "flex", "none"), "Feedback actions must retain their control geometry");
check(ruleHasDeclaration(root, ".workspace-actions > button", "background", "transparent"), "Workspace creation and search controls must stay quiet on the sidebar surface");
check(ruleHasDeclaration(root, ".workspace-actions", "grid-template-columns", "minmax(0, 1fr) var(--touch)", "(max-width: 680px)"), "Mobile Workspace creation and search controls must share one touch-height row without overflow");
check(ruleHasDeclaration(root, ".workspace-switcher-search:focus-within", "box-shadow", "inset 0 -2px 0 var(--focus-ring)"), "Workspace search must focus its composite row instead of outlining a naked input");
check(ruleHasDeclaration(root, ".memory-search:focus-within", "border-color", "var(--focus-border)"), "Memory search must focus its composite control boundary");
check(ruleHasDeclaration(root, ".meta-line", "gap", "var(--space-2)"), "Metadata rows must share the standard spacing rhythm");
check(ruleHasDeclaration(root, ".workspace-switcher-copy small > [data-meta]", "display", "inline-flex"), "Workspace switcher states must align their status dot and label");
check(ruleHasDeclaration(root, ".modal-title-group", "min-width", "0"), "Modal title groups must shrink before their actions");
check(ruleHasDeclaration(root, ".modal-heading", "display", "flex"), "Dialog titles with icons must share the modal heading grammar");
check(ruleHasDeclaration(root, ".modal > :is(.workspace-switcher-results, .shortcut-help-groups, .skill-editor-grid, .artifact-modal-body, .memory-modal > section)", "flex", "1"), "Dialog bodies must consume the remaining modal height");
check(ruleHasDeclaration(root, ".form-field", "display", "grid"), "Goals and Memory must share the canonical form-field grammar");
check(ruleHasDeclaration(root, ":is(.panel-empty, .workspace-switcher-empty)", "display", "grid"), "Secondary workspaces must share the canonical empty-state grammar");
check(ruleHasDeclaration(root, ":is(.panel-empty, .workspace-switcher-empty)", "align-content", "center"), "Empty-state content must keep its spacing rhythm instead of stretching across the available height");
check(ruleHasDeclaration(root, ":is(.panel-empty, .workspace-switcher-empty) > svg", "width", "var(--touch)"), "Empty-state icons must share one quiet bounded mark");
check(ruleHasDeclaration(root, ":is(.empty-state, .goal-empty, .goal-form-heading, .goal-hero) h2", "text-wrap", "balance"), "Primary empty and Goal headings must use balanced line wrapping");
check(ruleHasDeclaration(root, ":is(.memory-loading, .goal-loading)", "display", "grid"), "Memory and Goals must share the canonical loading stack");
check(ruleHasDeclaration(root, ":is(.memory-loading, .goal-loading) span", "height", "var(--bar-height)"), "Secondary-workspace loading rows must have visible shared geometry");
check(ruleHasDeclaration(root, ":is(.memory-tags, .memory-source-list, .inline-actions, .memory-operations-actions)", "display", "flex"), "Goals and Memory must share the canonical inline-action grammar");
check(ruleHasDeclaration(root, ".starter-prompts button", "padding", "var(--space-2)"), "Starter prompts must reserve stable padding before hover to prevent layout shift");
check(ruleHasDeclaration(root, ":is(.workspace-more, .artifact-download, .skill-row-actions button, .inbox-item > button)", "color", "var(--text-muted)"), "Dense icon actions must remain visible without hover");
check(ruleHasDeclaration(root, ".message-copy", "color", "var(--text-muted)"), "Message copy must remain visible without hover");
for (const selector of [".audit-panel-heading", ".modal-workspace-header", ".modal > header"]) check(ruleHasDeclaration(root, selector, "height", "var(--bar-height)"), `${selector} must use the shared application bar height`);
check(ruleHasDeclaration(root, ".panel-tabs .control:hover", "background", "transparent"), "Panel tab hover must not imitate the selected state");
check(ruleHasDeclaration(root, ".panel-tabs .control:hover", "border-color", "transparent"), "Panel tab hover must keep the ledger underline grammar borderless");
check(ruleHasDeclaration(root, ".memory-list > *", "align-items", "start"), "Dense Memory rows must align long content from the first text line");
check(ruleHasDeclaration(root, ".workspace-avatar-options > div", "grid-template-columns", "repeat(5, minmax(0, 1fr))"), "Workspace icon choices must keep their compact five-column grid");
check(ruleHasDeclaration(root, ".workspace-context-menu", "width", "calc(var(--sidebar-width) - var(--space-3))", "(max-width: 680px)"), "Mobile Workspace actions must use the rail width needed for touch-safe icon choices");
check(ruleHasDeclaration(root, ".workspace-avatar-options button", "min-height", "var(--touch)", "(max-width: 680px)"), "Mobile Workspace icon choices must use the shared touch target");
check(ruleHasDeclaration(root, ":is(.workspace-more, .artifact-download, .skill-row-actions button, .inbox-item > button)", "width", "var(--compact)"), "Dense icon actions must share the compact desktop target");
check(ruleHasDeclaration(root, ":is(.workspace-more, .message-copy, .artifact-download, .skill-row-actions button, .inbox-item > button)", "width", "var(--touch)", "(max-width: 680px)"), "Dense icon actions must expand to the shared mobile touch target");
check(ruleHasDeclaration(root, ".run-status-control", "width", "var(--touch)", "(max-width: 680px)"), "Mobile run status must use the shared touch target");
check(ruleHasDeclaration(root, ".inbox-item", "grid-template-columns", "var(--touch) var(--space-6) minmax(0, 1fr) var(--touch)", "(max-width: 680px)"), "Mobile Supervisor rows must reserve touch-safe edge actions without crowding their copy");
check(ruleHasDeclaration(root, ".goal-run-links > *", "text-align", "left"), "Goal audit rows must keep the shared ledger alignment");
check(ruleHasDeclaration(root, ".continuation-row", "grid-template-columns", "minmax(0, 1fr) auto"), "Continuation rows must reserve a shrink-safe reason column");
check(ruleHasDeclaration(root, ".continuation-row > div", "grid-template-columns", "auto minmax(0, 1fr)"), "Continuation reasons must shrink within the Run details ledger");
check(ruleHasDeclaration(root, ".continuation-row > div > span", "overflow-wrap", "anywhere"), "Continuation identifiers must wrap instead of widening the Run details drawer");
check(ruleHasDeclaration(root, ".memory-operation-group .memory-list > div > div", "grid-template-columns", "auto minmax(0, 1fr) auto"), "Memory jobs must keep status, source, and metrics on one scan line");
check(ruleHasDeclaration(root, ".memory-operation-group .memory-list > div > div", "grid-template-columns", "auto minmax(0, 1fr)", "(max-width: 680px)"), "Mobile Memory jobs must move metrics below the primary status and source line");
check(ruleHasDeclaration(root, ".memory-operation-group .memory-list > div > div > small", "grid-column", "2", "(max-width: 680px)"), "Mobile Memory job metrics must align with their source");

const appPanelsSource = read(path.join(srcRoot, "AppPanels.tsx"));
check(appPanelsSource.includes("selectedId && createPortal("), "Artifact previews must escape the Run details drawer through the shared modal portal");
check(appPanelsSource.includes("useModalFocus(Boolean(selectedId)"), "Artifact previews must share modal focus, Escape, and restoration behavior");
const memoryPanelSource = read(path.join(srcRoot, "MemoryPanel.tsx"));
check(memoryPanelSource.includes("createPortal(content, document.body)"), "Memory must render through the shared document-level portal");
check(memoryPanelSource.includes('typeof document === "undefined"'), "Memory portal rendering must retain its server-rendering fallback");
check(memoryPanelSource.includes("useModalFocus(true") && memoryPanelSource.includes("useModalFocus(captureOpen"), "Memory and nested capture must share modal focus, Escape, and restoration behavior");
check(memoryPanelSource.includes("inert={captureOpen ? true : undefined}"), "Nested Memory capture must make the parent workspace inert");
const goalsPanelSource = read(path.join(srcRoot, "GoalsPanel.tsx"));
check(goalsPanelSource.includes("createPortal(content, document.body)"), "Goals must render through the shared document-level portal");
check(goalsPanelSource.includes('typeof document === "undefined"'), "Goals portal rendering must retain its server-rendering fallback");
check(goalsPanelSource.includes("useModalFocus(true"), "Goals must share modal focus, Escape, and restoration behavior");

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

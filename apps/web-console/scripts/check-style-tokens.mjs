import { readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import postcss from "postcss";

const sourceRoot = new URL("../src/", import.meta.url);
const projectRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const rawColor = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|:\s*(?:white|black)\b/i;
const layoutAppearanceProperty = /^(?:-webkit-(?:font-smoothing|tap-highlight-color|text-fill-color|text-stroke(?:-.+)?)|accent-color|animation(?:-.+)?|appearance|backdrop-filter|background(?:-.+)?|border(?:-.+)?|box-shadow|caret-color|clip-path|color|color-scheme|column-rule(?:-.+)?|cursor|fill|filter|font(?:-.+)?|forced-color-adjust|letter-spacing|line-height|list-style(?:-.+)?|mask(?:-.+)?|mix-blend-mode|opacity|outline(?:-.+)?|paint-order|print-color-adjust|scrollbar-(?:color|width)|stroke(?:-.+)?|text-(?:align|decoration(?:-.+)?|emphasis(?:-.+)?|rendering|shadow|transform|underline-offset)|transition(?:-.+)?|vertical-align|word-spacing)$/i;
const designMechanicProperty = /^(?:-webkit-(?:box-orient|line-clamp|overflow-scrolling)|align-(?:content|items|self)|aspect-ratio|block-size|bottom|box-sizing|break-(?:after|before|inside)|clear|clip|column-(?:count|fill|gap|span|width)|columns|contain(?:-.+)?|content-visibility|direction|display|empty-cells|flex(?:-.+)?|float|gap|grid(?:-.+)?|height|hyphens|inline-size|inset(?:-.+)?|isolation|justify-(?:content|items|self)|left|margin(?:-.+)?|max-(?:block-size|height|inline-size|width)|min-(?:block-size|height|inline-size|width)|object-(?:fit|position)|order|overflow(?:-.+)?|overscroll-behavior(?:-.+)?|padding(?:-.+)?|place-(?:content|items|self)|pointer-events|position|resize|right|row-gap|scroll-(?:behavior|margin(?:-.+)?|padding(?:-.+)?|snap-(?:align|stop|type))|scrollbar-gutter|table-layout|text-overflow|top|touch-action|visibility|white-space|width|word-break|word-wrap|writing-mode|z-index)$/i;
const dynamicClasses = new Set(["unsupported", "hljs", "language_", "class_", "inherited__", "function_"]);
const expectedStyleFiles = ["cascade.css", "design-system.css", "goal-styles.css", "layout.css"];
const expectedStyleImports = ["cascade.css", "layout.css", "design-system.css", "goal-styles.css"];

function read(relativePath, root = sourceRoot) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function block(source, selector) {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex < 0) throw new Error(`Missing style block: ${selector}`);
  const openIndex = source.indexOf("{", selectorIndex + selector.length);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return { body: source.slice(openIndex + 1, index), end: index + 1 };
  }
  throw new Error(`Unclosed style block: ${selector}`);
}

function tokens(cssBlock) {
  return new Map(
    [...cssBlock.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((match) => [match[1], match[2].trim()]),
  );
}

function normalizedMediaContext(node) {
  const media = [];
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent) {
    if (parent.type === "atrule" && parent.name === "media") media.unshift(parent.params.replace(/\s+/g, ""));
  }
  return media.join("&&");
}

function ruleDeclarationEntries(root, selector, media = "") {
  const entries = [];
  const expectedMedia = media === null ? null : media.replace(/\s+/g, "");
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector) || (expectedMedia !== null && normalizedMediaContext(rule) !== expectedMedia)) return;
    let sublayer;
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "layer" && ["baseline", "refinement"].includes(parent.params.trim())) {
        sublayer = parent.params.trim();
      }
    }
    for (const node of rule.nodes) {
      if (node.type === "decl") entries.push({ property: node.prop, value: node.value.trim(), sublayer });
    }
  });
  return entries;
}

function ruleDeclarations(root, selector, media = "") {
  const values = new Map();
  for (const entry of ruleDeclarationEntries(root, selector, media)) values.set(entry.property, entry.value);
  return values;
}

function assertCanonicalTokenAliases(themeTokens) {
  const expected = new Map([
    ["row-compact", "var(--control-lg)"],
    ["row-default", "var(--control-xl)"],
    ["row-touch", "var(--control-touch)"],
    ["row-list", "var(--space-48)"],
    ["row-bar", "var(--space-64)"],
  ]);
  const actual = new Map([...themeTokens].filter(([, value]) => /^var\(--[a-z0-9-]+\)$/i.test(value)));
  if (JSON.stringify([...actual]) !== JSON.stringify([...expected])) {
    throw new Error(`Direct style-token aliases are reserved for the canonical semantic row scale; found ${[...actual].map(([name, value]) => `--${name}: ${value}`).join(", ")}`);
  }
}

function oklchToLinearSrgb(value, tokenName) {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/i);
  if (!match) throw new Error(`--${tokenName} must remain an opaque OKLCH base color for contrast verification`);
  const [, lightness, chroma, hue] = match.map(Number);
  const hueRadians = hue * Math.PI / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
}

function relativeLuminance([red, green, blue]) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function assertReadableThemeContrast(lightTokens, darkOverrides) {
  const themes = [
    ["light", lightTokens],
    ["dark", new Map([...lightTokens, ...darkOverrides])],
  ];
  for (const [theme, themeTokens] of themes) {
    const colors = new Map();
    for (const tokenName of [
      "background", "surface", "surface-raised", "surface-muted",
      "foreground", "foreground-muted", "accent", "accent-hover", "accent-contrast",
      "info", "success", "warning", "danger",
    ]) {
      colors.set(tokenName, oklchToLinearSrgb(themeTokens.get(tokenName) ?? "", tokenName));
    }
    for (const foregroundName of ["foreground", "foreground-muted"]) {
      for (const surfaceName of ["background", "surface", "surface-raised", "surface-muted"]) {
        const ratio = contrastRatio(colors.get(foregroundName), colors.get(surfaceName));
        if (ratio < 4.5) {
          throw new Error(`${theme} --${foregroundName} on --${surfaceName} has ${ratio.toFixed(2)}:1 contrast; text tokens require at least 4.5:1`);
        }
      }
    }
    for (const foregroundName of ["accent", "info", "success", "warning", "danger"]) {
      for (const surfaceName of ["background", "surface", "surface-raised", "surface-muted"]) {
        const ratio = contrastRatio(colors.get(foregroundName), colors.get(surfaceName));
        if (ratio < 4.5) {
          throw new Error(`${theme} --${foregroundName} on --${surfaceName} has ${ratio.toFixed(2)}:1 contrast; semantic text colors require at least 4.5:1`);
        }
      }
    }
    for (const backgroundName of ["accent", "accent-hover"]) {
      const ratio = contrastRatio(colors.get("accent-contrast"), colors.get(backgroundName));
      if (ratio < 4.5) {
        throw new Error(`${theme} --accent-contrast on --${backgroundName} has ${ratio.toFixed(2)}:1 contrast; filled actions require at least 4.5:1`);
      }
    }
    const faintValue = themeTokens.get("foreground-faint") ?? "";
    const faintMix = faintValue.match(/^color-mix\(in oklab, var\(--foreground-muted\)\s+([\d.]+)%, transparent\)$/i);
    if (!faintMix) throw new Error("--foreground-faint must derive from --foreground-muted with explicit transparency");
    const alpha = Number(faintMix[1]) / 100;
    const raised = colors.get("surface-raised");
    const faint = colors.get("foreground-muted").map((channel, index) => alpha * channel + (1 - alpha) * raised[index]);
    const faintRatio = contrastRatio(faint, raised);
    if (faintRatio < 4.5) {
      throw new Error(`${theme} --foreground-faint on --surface-raised has ${faintRatio.toFixed(2)}:1 contrast; placeholder text requires at least 4.5:1`);
    }
  }
}

function assertReadableTypeScale(themeTokens) {
  const scale = ["text-2xs", "text-xs", "text-sm", "text-ui", "text-body", "text-md", "text-lg", "text-title", "text-heading", "text-display"];
  let previous = 0;
  for (const tokenName of scale) {
    const value = themeTokens.get(tokenName) ?? "";
    const match = value.match(/^([\d.]+)rem$/i);
    if (!match) throw new Error(`--${tokenName} must remain a rem-based shared type size`);
    const rem = Number(match[1]);
    if (rem <= previous) throw new Error(`--${tokenName} must be larger than the preceding shared type size`);
    previous = rem;
  }
  if (Number(themeTokens.get("text-2xs")?.match(/^([\d.]+)rem$/i)?.[1]) < 0.5625) {
    throw new Error("--text-2xs must remain at least 0.5625rem so micro labels do not regress below 9px at the default root size");
  }
  if (Number(themeTokens.get("text-body")?.match(/^([\d.]+)rem$/i)?.[1]) < 0.8125) {
    throw new Error("--text-body must remain at least 0.8125rem so routine content does not regress below 13px at the default root size");
  }
}

function assertSharedContentMeasures(layoutSource, goalSource, themeTokens) {
  const expectedTokens = new Map([
    ["content-measure", "860px"],
    ["empty-state-measure", "500px"],
    ["reading-measure", "72ch"],
  ]);
  for (const [tokenName, expected] of expectedTokens) {
    const actual = themeTokens.get(tokenName);
    if (actual !== expected) throw new Error(`--${tokenName} must remain ${expected}; found ${actual ?? "undefined"}`);
  }
  if (themeTokens.has("conversation-measure")) {
    throw new Error("--conversation-measure is retired; shared work surfaces use --content-measure");
  }

  const roots = new Map([
    ["src/layout.css", postcss.parse(layoutSource, { from: "src/layout.css" })],
    ["src/goal-styles.css", postcss.parse(goalSource, { from: "src/goal-styles.css" })],
  ]);
  const rules = [
    [layoutSource, "src/layout.css", ".message", { "max-width": "var(--content-measure)" }],
    [layoutSource, "src/layout.css", ".message.user", { "max-width": "min(var(--reading-measure), 82%)" }],
    [layoutSource, "src/layout.css", ".message.assistant .markdown > :not(.code-block):not(.markdown-table-wrap)", { "max-width": "var(--reading-measure)" }],
    [layoutSource, "src/layout.css", ".empty-state", { width: "min(var(--empty-state-measure), 100%)" }],
    [layoutSource, "src/layout.css", ".empty-state p", { "max-width": "var(--reading-measure)" }],
    [layoutSource, "src/layout.css", ".markdown hr", { height: "var(--stroke-hairline)" }],
    [layoutSource, "src/layout.css", ".conversation-date-divider::before", { height: "var(--stroke-hairline)" }],
    [layoutSource, "src/layout.css", ".conversation-date-divider::after", { height: "var(--stroke-hairline)" }],
    [goalSource, "src/goal-styles.css", ".goal-alert", { "max-width": "var(--content-measure)" }],
    [goalSource, "src/goal-styles.css", ".goal-empty", { "max-width": "var(--empty-state-measure)" }],
    [goalSource, "src/goal-styles.css", ".goal-empty p", { "max-width": "var(--reading-measure)" }],
    [goalSource, "src/goal-styles.css", ".goal-loading", { width: "min(var(--content-measure),100%)" }],
    [goalSource, "src/goal-styles.css", ".goal-loading span", { height: "var(--row-spacious)" }],
    [goalSource, "src/goal-styles.css", ".goal-loading span:first-child", { height: "calc(var(--row-bar) * 2)" }],
    [goalSource, "src/goal-styles.css", ".goal-main", { padding: "var(--space-20) clamp(var(--space-20),3vw,var(--space-40))" }],
    [goalSource, "src/goal-styles.css", ".goal-form", { width: "min(var(--content-measure),100%)", gap: "var(--space-12)" }],
    [goalSource, "src/goal-styles.css", ".goal-view", { width: "min(var(--content-measure),100%)" }],
    [goalSource, "src/goal-styles.css", ".goal-hero>p", { "max-width": "var(--reading-measure)" }],
    [goalSource, "src/goal-styles.css", ".goal-section-heading p", { "max-width": "var(--reading-measure)" }],
  ];
  for (const [, file, selector, expected] of rules) {
    const values = ruleDeclarations(roots.get(file), selector);
    for (const [property, value] of Object.entries(expected)) {
      if (values.get(property) !== value) {
        throw new Error(`${selector} must use the shared content geometry; expected ${property}: ${value}`);
      }
    }
  }
}

function rejectRawColors(file, source) {
  const match = rawColor.exec(source);
  if (!match) return;
  const line = source.slice(0, match.index).split("\n").length;
  throw new Error(`${file}:${line} contains a raw color; use a semantic token instead`);
}

function rejectLocalColorMix(file, source) {
  const match = /color-mix\(/i.exec(source);
  if (!match) return;
  const line = source.slice(0, match.index).split("\n").length;
  throw new Error(`${file}:${line} contains a local color mix; define a semantic color token instead`);
}

function rejectLocalFontStacks(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls(/^(?:font|font-family)$/i, (declaration) => {
    if (!/(?:ui-(?:sans-serif|monospace)|system-ui|-apple-system|BlinkMacSystemFont|SFMono-Regular|Menlo|Consolas|monospace|sans-serif)/i.test(declaration.value)) return;
    throw new Error(`${file}:${declaration.source.start.line} defines a component-local font stack; use --font-sans or --font-mono`);
  });
}

const semanticFillActionSelectors = new Set([
  ".user-input-card button",
  ".user-input-card button:hover:not(:disabled)",
  ".skill-catalog-row.selected .skill-select-box",
  ".skill-editor-dialog > footer button.primary",
  ".skill-editor-dialog > footer button.primary:hover:not(:disabled)",
  ".approval-approve",
  ".approval-approve:hover:not(:disabled)",
  ".composer button",
  ".composer button:hover:not(:disabled)",
  ".memory-primary",
  ".memory-primary:hover:not(:disabled)",
]);

const semanticFillIndicatorSelector = /^(?:\.workspace-run-status\.[a-z_]+ \.workspace-status-dot|\.pulse|\.run-status-control\.[a-z_]+ > span|\.history-status\.[a-z_]+|\.unread-dot|\.jump-to-latest i|\.collapsed-audit-dot\.[a-z_]+|\.audit-panel-collapse\.attention \.collapsed-audit-dot|\.workspace-tooltip-status\.[a-z_]+|\.memory-job-state\.(?:info|success|warning|danger) \.memory-job-dot|\.goal-nav-dot\.(?:info|success|warning|danger)|\.goal-mini-progress i|\.goal-progress-track i)$/;

function rejectBroadSemanticFills(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls(/^(?:background(?:-color|-image)?)$/i, (declaration) => {
    if (!/var\(--(?:accent(?:-hover)?|info|success|warning|danger)\)/i.test(declaration.value)) return;
    const rule = declaration.parent;
    if (rule?.type === "rule" && rule.selectors.every((selector) => {
      const normalized = selector.trim();
      return semanticFillActionSelectors.has(normalized) || semanticFillIndicatorSelector.test(normalized);
    })) return;
    throw new Error(`${file}:${declaration.source.start.line} uses semantic color as a broad surface fill; reserve it for primary actions, indicators, progress, text, focus, or a thin edge`);
  });
}

function rejectGlassEffects(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls((declaration) => {
    if (/^(?:-webkit-)?backdrop-filter$/i.test(declaration.prop)) {
      throw new Error(`${file}:${declaration.source.start.line} uses backdrop blur; use an opaque semantic surface instead`);
    }
    if (/^--surface-(?:translucent|overlay(?:-muted)?)$/i.test(declaration.prop)) {
      throw new Error(`${file}:${declaration.source.start.line} defines a glass-surface token; use an opaque semantic surface instead`);
    }
  });
}

function rejectLayoutAppearance(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls((declaration) => {
    if (!layoutAppearanceProperty.test(declaration.prop)) return;
    throw new Error(`${file}:${declaration.source.start.line} ${declaration.prop} is visual appearance; move it to the design baseline`);
  });
  root.walkAtRules(/^(?:-webkit-)?keyframes$/i, (rule) => {
    throw new Error(`${file}:${rule.source.start.line} @${rule.name} is visual motion; move it to the design baseline`);
  });
}

function rejectDesignMechanics(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls((declaration) => {
    if (!designMechanicProperty.test(declaration.prop)) return;
    throw new Error(`${file}:${declaration.source.start.line} ${declaration.prop} is structural geometry; move it to the layout refinement`);
  });
}

function rejectRawSmallSquares(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkRules((rule) => {
    if (rule.selectors.every((selector) => selector.trim() === ".sr-only")) return;
    const dimensions = new Map();
    for (const node of rule.nodes) {
      if (node.type === "decl" && (node.prop === "width" || node.prop === "height")) {
        dimensions.set(node.prop, node);
      }
    }
    const width = dimensions.get("width");
    const height = dimensions.get("height");
    if (!width || !height || width.value.trim() !== height.value.trim()) return;
    const rawSize = width.value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
    if (!rawSize || Number(rawSize[1]) > 48) return;
    throw new Error(`${file}:${width.source.start.line} ${rule.selector} uses raw ${rawSize[0]} square geometry; use an indicator, icon, or control token`);
  });
}

function rejectRawDensityHeights(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls(/^(?:height|min-height)$/i, (declaration) => {
    const rawSize = declaration.value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
    if (!rawSize) return;
    const pixels = Number(rawSize[1]);
    if (pixels < 24 || pixels > 84) return;
    throw new Error(`${file}:${declaration.source.start.line} ${declaration.prop} uses raw ${rawSize[0]} density geometry; use a control or row token`);
  });
}

function rejectRawMicroGeometry(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls("transform", (declaration) => {
    if (!/-?(?:\d*\.)?\d+px\b/i.test(declaration.value)) return;
    throw new Error(`${file}:${declaration.source.start.line} transform uses a raw pixel offset; use the shared spacing scale`);
  });
  root.walkDecls("grid-template-columns", (declaration) => {
    const rawCompactTracks = [...declaration.value.matchAll(/(\d+(?:\.\d+)?)px\b/gi)]
      .filter((match) => Number(match[1]) <= 20);
    if (!rawCompactTracks.length) return;
    throw new Error(`${file}:${declaration.source.start.line} grid-template-columns uses raw compact tracks; use the shared indicator or spacing scale`);
  });
  root.walkDecls("height", (declaration) => {
    const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
    if (!/progress/i.test(selector) || !/^\d+(?:\.\d+)?px$/i.test(declaration.value.trim())) return;
    throw new Error(`${file}:${declaration.source.start.line} ${selector} uses a raw progress height; use the shared spacing scale`);
  });
  root.walkDecls(/^(?:width|height|min-width|min-height)$/i, (declaration) => {
    const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
    if (selector.split(",").every((entry) => entry.trim() === ".sr-only")) return;
    const rawSize = declaration.value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
    if (!rawSize || Number(rawSize[1]) < 16 || Number(rawSize[1]) > 26) return;
    throw new Error(`${file}:${declaration.source.start.line} ${selector} uses raw compact geometry; use the shared indicator or control scale`);
  });
  root.walkDecls(/^(?:top|right|bottom|left)$/i, (declaration) => {
    const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
    const rawCompactOffsets = [...declaration.value.matchAll(/-?(\d+(?:\.\d+)?)px\b/gi)]
      .filter((match) => Number(match[1]) <= 12);
    if (!rawCompactOffsets.length) return;
    throw new Error(`${file}:${declaration.source.start.line} ${selector} uses a raw compact position offset; use the shared spacing scale`);
  });
}

function rejectOverrideImportant(file, source) {
  const root = postcss.parse(source, { from: file });
  root.walkDecls((declaration) => {
    if (!declaration.important) return;
    const accessibilityRule = declaration.parent?.type === "rule"
      && declaration.parent.selectors.every((selector) => selector.trim() === ".sr-only");
    let reducedMotion = false;
    for (let parent = declaration.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "media" && /prefers-reduced-motion\s*:\s*reduce/i.test(parent.params)) {
        reducedMotion = true;
        break;
      }
    }
    if (accessibilityRule || reducedMotion) return;
    throw new Error(`${file}:${declaration.source.start.line} ${declaration.prop} uses !important as a cascade override; fix ownership or selector scope instead`);
  });
}

function assertLayerOwned(file, source, layerName) {
  const layer = `@layer ${layerName}`;
  let cursor = 0;
  let layerCount = 0;
  while (cursor < source.length) {
    const layerIndex = source.indexOf(layer, cursor);
    const unowned = source
      .slice(cursor, layerIndex < 0 ? source.length : layerIndex)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    if (unowned) throw new Error(`${file} contains rules outside ${layer}`);
    if (layerIndex < 0) break;
    const ownedBlock = block(source.slice(layerIndex), layer);
    cursor = layerIndex + ownedBlock.end;
    layerCount += 1;
  }
  if (!layerCount) throw new Error(`${file} must be owned by ${layer}`);
}

function assertDesignSublayers(file, source) {
  const root = postcss.parse(source, { from: file });
  const designLayers = root.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.params.trim() === "design");
  if (!designLayers.length) throw new Error(`${file} must contain an @layer design owner`);
  const order = designLayers.flatMap((layer) => layer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && !node.nodes && node.params.trim() === "baseline, refinement"));
  const baselines = designLayers.flatMap((layer) => layer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.params.trim() === "baseline"));
  const refinements = designLayers.flatMap((layer) => layer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.params.trim() === "refinement"));
  if (order.length !== 1 || baselines.length !== 1 || !refinements.length) {
    throw new Error(`${file} must declare exactly one ordered baseline and one or more refinement blocks`);
  }
  let baselineDeclarations = 0;
  let refinementDeclarations = 0;
  baselines[0].walkDecls(() => baselineDeclarations += 1);
  for (const refinement of refinements) refinement.walkDecls(() => refinementDeclarations += 1);
  if (!baselineDeclarations || !refinementDeclarations) throw new Error(`${file} design baseline and refinement must both own appearance`);
  root.walkDecls((declaration) => {
    let owned = false;
    for (let parent = declaration.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "layer" && ["baseline", "refinement"].includes(parent.params.trim())) {
        owned = true;
        break;
      }
    }
    if (!owned) throw new Error(`${file}:${declaration.source.start.line} design declaration must belong to baseline or refinement`);
  });
}

function assertLayoutSublayers(file, source) {
  const root = postcss.parse(source, { from: file });
  const layoutLayers = root.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.params.trim() === "layout");
  if (layoutLayers.length !== 1) throw new Error(`${file} must contain exactly one @layer layout owner`);
  const layoutLayer = layoutLayers[0];
  const order = layoutLayer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && !node.nodes && node.params.trim() === "base, refinement");
  const bases = layoutLayer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.nodes && node.params.trim() === "base");
  const refinements = layoutLayer.nodes.filter((node) => node.type === "atrule" && node.name === "layer" && node.nodes && node.params.trim() === "refinement");
  if (order.length !== 1 || bases.length !== 1 || refinements.length !== 1) {
    throw new Error(`${file} must declare exactly one ordered @layer base, refinement pair`);
  }
  if (!(layoutLayer.index(order[0]) < layoutLayer.index(bases[0]) && layoutLayer.index(bases[0]) < layoutLayer.index(refinements[0]))) {
    throw new Error(`${file} must order layout sublayers as base then refinement`);
  }
  let baseDeclarations = 0;
  let refinementDeclarations = 0;
  bases[0].walkDecls(() => baseDeclarations += 1);
  refinements[0].walkDecls(() => refinementDeclarations += 1);
  if (!baseDeclarations || !refinementDeclarations) throw new Error(`${file} layout base and refinement must both own mechanics`);
}

function declarationOwners(file, source) {
  const owners = new Map();
  const root = postcss.parse(source, { from: file });
  let duplicate;
  root.walkRules((rule) => {
    if (duplicate) return;
    const context = [];
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name !== "layer") context.unshift(`@${parent.name} ${parent.params}`);
    }
    for (const selector of rule.selectors) {
      const declarations = new Map();
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        declarations.set(node.prop, node);
      }
      for (const node of declarations.values()) {
        const key = `${context.join(" > ")}\u0000${selector.trim()}\u0000${node.prop}`;
        const previous = owners.get(key);
        if (previous) {
          duplicate = `${file}:${node.source.start.line} repeats ${selector.trim()} ${node.prop}; first declared on line ${previous.line}`;
          return;
        }
        owners.set(key, { file, line: node.source.start.line, property: node.prop, selector: selector.trim() });
      }
    }
  });
  if (duplicate) throw new Error(duplicate);
  return owners;
}

function rejectCrossLayerShadows(layerSources) {
  const owners = new Map();
  for (const [file, source] of layerSources) {
    for (const [key, declaration] of declarationOwners(file, source)) {
      const previous = owners.get(key);
      if (previous) {
        throw new Error(`${file}:${declaration.line} shadows ${previous.file}:${previous.line} for ${declaration.selector} ${declaration.property}`);
      }
      owners.set(key, declaration);
    }
  }
}

function assertStarterPromptLedger(layoutSource, designSource) {
  const root = postcss.parse(designSource, { from: "src/design-system.css" });
  const surface = ruleDeclarations(root, ".starter-prompts");
  const item = ruleDeclarations(root, ".starter-prompts button");
  const columnDivider = ruleDeclarations(root, ".starter-prompts button:nth-child(odd)");
  const rowDivider = ruleDeclarations(root, ".starter-prompts button:nth-child(-n + 2)");
  if (surface.get("border") !== "var(--stroke-hairline) solid var(--border)"
    || surface.get("background") !== "var(--surface-prompt)"
    || item.get("border") !== "0"
    || item.get("border-radius") !== "0"
    || item.get("background") !== "transparent"
    || columnDivider.get("border-right") !== "var(--stroke-hairline) solid var(--border)"
    || rowDivider.get("border-bottom") !== "var(--stroke-hairline) solid var(--border)") {
    throw new Error("Starter prompts must remain one shared ledger with internal hairlines, not separate cards");
  }
  const layoutRoot = postcss.parse(layoutSource, { from: "src/layout.css" });
  if (ruleDeclarations(layoutRoot, ".empty-state").get("width") !== "min(var(--empty-state-measure), 100%)"
    || ruleDeclarations(layoutRoot, ".starter-prompts").get("width") !== "100%") {
    throw new Error("Starter prompts must fill the shared empty-state measure so readable shared type does not truncate prompt details");
  }
}

function assertEvidenceLedgers(source) {
  const root = postcss.parse(source, { from: "src/design-system.css" });
  const hairline = "var(--stroke-hairline) solid var(--border)";
  const rules = [
    [".audit-ledger", { "border-top": hairline, "border-bottom": hairline }],
    [".run-evidence-ledger", { "border-top": hairline, "border-bottom": hairline }],
    [".run-evidence-group + .run-evidence-group", { "border-top": hairline }],
    [".run-evidence-group .task-row + .task-row", { "border-top": hairline }],
    [".run-evidence-group .continuation-row + .continuation-row", { "border-top": hairline }],
    [".run-contract", { "border-top": hairline, "border-bottom": hairline }],
    [".audit-disclosure", { "border-top": hairline, "border-bottom": hairline, "border-radius": "0", background: "transparent" }],
    [".gate-evaluation", { border: "0", "border-bottom": hairline, "border-radius": "0" }],
    [".criterion-row", { border: "0", "border-bottom": hairline, "border-radius": "0" }],
    [".gate-detail", { border: "0", "border-bottom": hairline, "border-radius": "0" }],
    [".memory-job-row", { "border-bottom": hairline }],
    [".topic-grid > button", { border: "0", "border-bottom": hairline, "border-radius": "0", background: "transparent" }],
    [".recall-grid > button", { border: "0", "border-bottom": hairline, "border-radius": "0", background: "transparent" }],
    [".memory-detail-content dl div", { border: "0", "border-bottom": hairline, "border-radius": "0" }],
  ];
  for (const [selector, expected] of rules) {
    const values = ruleDeclarations(root, selector);
    for (const [property, value] of Object.entries(expected)) {
      if (values.get(property) !== value) throw new Error(`${selector} must remain a continuous hairline ledger; expected ${property}: ${value}`);
    }
    const radius = values.get("border-radius");
    if (radius && radius !== "0") throw new Error(`${selector} must not regain card radius`);
    const background = values.get("background");
    if (background && background !== "transparent" && selector !== ".memory-detail-content dl div") {
      throw new Error(`${selector} must not regain an independent card background`);
    }
  }
}

function assertInterfaceLedgers(layoutSource, designSource, goalSource) {
  const roots = new Map([
    ["src/layout.css", postcss.parse(layoutSource, { from: "src/layout.css" })],
    ["src/design-system.css", postcss.parse(designSource, { from: "src/design-system.css" })],
    ["src/goal-styles.css", postcss.parse(goalSource, { from: "src/goal-styles.css" })],
  ]);
  const hairline = "var(--stroke-hairline) solid var(--border)";
  const rules = [
    [layoutSource, "src/layout.css", ".skill-catalog", { gap: "0", "padding-top": "0" }],
    [layoutSource, "src/layout.css", ".workspace-profile-settings", { padding: "0", gap: "0" }],
    [layoutSource, "src/layout.css", ".execution-timeline-body", { padding: "0", gap: "0" }],
    [layoutSource, "src/layout.css", ".context-manifest-disclosure", { padding: "0" }],
    [layoutSource, "src/layout.css", ".audit-disclosure > summary", { "grid-template-columns": "var(--indicator-check) minmax(0,1fr) var(--indicator-check)", "grid-template-rows": "auto auto", "column-gap": "var(--space-6)", "row-gap": "0" }],
    [layoutSource, "src/layout.css", ".audit-disclosure > summary > span", { "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "grid-column": "2", "grid-row": "1", "align-self": "end" }],
    [layoutSource, "src/layout.css", ".audit-disclosure > summary > small", { "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "grid-column": "2", "grid-row": "2", "align-self": "start" }],
    [layoutSource, "src/layout.css", ".audit-disclosure > summary > svg:first-child", { "grid-column": "1", "grid-row": "1 / 3" }],
    [layoutSource, "src/layout.css", ".audit-disclosure > summary > .tool-chevron", { "grid-column": "3", "grid-row": "1 / 3" }],
    [layoutSource, "src/layout.css", ".memory-content.detail-unavailable", { "grid-template-columns": "224px minmax(400px, 1fr)" }],
    [goalSource, "src/goal-styles.css", ".goal-shell.empty-collection", { "grid-template-columns": "minmax(0,1fr)" }],
    [goalSource, "src/goal-styles.css", ".goal-editor-section", { padding: "var(--space-12) 0", border: "0", "border-top": hairline, "border-radius": "0", background: "transparent" }],
    [goalSource, "src/goal-styles.css", ".goal-form>.goal-disclosure", { "border-right": "0", "border-left": "0", "border-radius": "0", background: "transparent" }],
    [goalSource, "src/goal-styles.css", ".goal-roadmap-editor", { gap: "0" }],
    [goalSource, "src/goal-styles.css", ".goal-roadmap-editor>section", { border: "0", "border-top": hairline, "border-radius": "0", background: "transparent" }],
    [goalSource, "src/goal-styles.css", ".goal-criterion-links", { border: "0", "border-top": hairline, "border-radius": "0", background: "transparent" }],
    [designSource, "src/design-system.css", ".skill-catalog-row", { "border-top": hairline, "border-radius": "0" }],
    [designSource, "src/design-system.css", ".workspace-profile-settings", { border: hairline }],
    [designSource, "src/design-system.css", ".workspace-profile-settings label", { border: "0", "border-radius": "0", background: "transparent" }],
    [designSource, "src/design-system.css", ".workspace-profile-settings label + label", { "border-left": hairline }],
    [designSource, "src/design-system.css", ".execution-timeline-body", { "border-top": hairline }],
    [designSource, "src/design-system.css", ".run-step", { border: "0", "border-radius": "0", background: "transparent" }],
    [designSource, "src/design-system.css", ".execution-timeline-body > .run-step + .run-step", { "border-top": hairline }],
  ];
  for (const [, file, selector, expected] of rules) {
    const values = ruleDeclarations(roots.get(file), selector);
    for (const [property, value] of Object.entries(expected)) {
      if (values.get(property) !== value) throw new Error(`${selector} must remain a continuous interface ledger; expected ${property}: ${value}`);
    }
  }
}

function assertWorkspaceSwitcherLayout(source) {
  const root = postcss.parse(source, { from: "src/layout.css" });
  const areas = [...(ruleDeclarations(root, ".workspace-switcher").get("grid-template-areas") ?? "").matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  if (JSON.stringify(areas) !== JSON.stringify(["header", "search", "results", "footer"])) {
    throw new Error("Workspace switcher rows must keep fixed named areas so an omitted search field cannot move results or footer controls");
  }
  for (const [selector, expected] of [
    [".workspace-switcher > header", "header"],
    [".workspace-switcher-search", "search"],
    [".workspace-switcher-results", "results"],
    [".workspace-switcher > footer", "footer"],
  ]) {
    if (ruleDeclarations(root, selector).get("grid-area") !== expected) {
      throw new Error(`${selector} must remain in the ${expected} Workspace switcher area`);
    }
  }
}

function assertCollapsedWorkspaceTooltipBehavior(source) {
  const root = postcss.parse(source, { from: "src/design-system.css" });
  const expectedHover = ".workspace-rail.collapsed .workspace-item:hover .collapsed-workspace-tooltip";
  const expectedKeyboard = ".workspace-rail.collapsed .workspace-select:focus-visible ~ .collapsed-workspace-tooltip";
  let hasHover = false;
  let hasKeyboard = false;
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (!selector.includes(".collapsed-workspace-tooltip")) continue;
      if (selector.includes(":focus-within")) {
        throw new Error("Collapsed Workspace tooltips must not persist after pointer focus; use the primary button's :focus-visible state");
      }
      if (selector.trim() === expectedHover) hasHover = true;
      if (selector.trim() === expectedKeyboard) hasKeyboard = true;
    }
  });
  if (!hasHover || !hasKeyboard) {
    throw new Error("Collapsed Workspace tooltips must appear on row hover and primary-button :focus-visible only");
  }
}

function assertMobileTouchTargets(source, goalSource) {
  const root = postcss.parse(source, { from: "src/layout.css" });
  const touch = "var(--control-touch)";
  const rules = [
    [".new-workspace", { height: touch, "min-height": touch }],
    [".workspace-search", { height: touch, "min-height": touch }],
    [".workspace-search input", { "min-height": touch }],
    [".workspace-search button", { width: touch, height: touch }],
    [".workspace-more", { width: touch, height: touch }],
    [".workspace-select", { "padding-right": "var(--space-64)" }],
    [".workspace-context-menu > button", { "min-height": touch }],
    [".workspace-avatar-options button", { width: touch, height: touch }],
    [".inbox-item", { "grid-template-columns": `${touch} var(--control-xs) minmax(0, 1fr) ${touch}` }],
    [".queue-drag-handle", { width: touch, height: touch }],
    [".inbox-item > button:last-child", { width: touch, height: touch }],
    [".memory-section-heading > button", { "min-height": touch }],
    [".load-older", { "min-height": touch }],
    [".audit-disclosure > summary", { "min-height": touch }],
    [".context-manifest-card select", { "min-height": touch }],
    [".artifact-row", { "grid-template-columns": `var(--indicator-badge) minmax(0, 1fr) ${touch}` }],
    [".artifact-open", { "min-height": touch }],
    [".artifact-download", { width: touch, height: touch }],
    [".message-copy", { width: touch, height: touch }],
    [".inbox-actions", { "flex-wrap": "wrap" }],
    [".inbox-item .inbox-actions button", { "min-width": touch, "min-height": touch }],
    [".memory-load-more", { "min-height": touch }],
    [".workspace-navigation-empty button", { "min-height": touch }],
    [".workspace-switcher > header button", { width: touch, height: touch }],
    [".workspace-switcher-search input", { "min-height": touch }],
    [".workspace-switcher > footer > button", { "min-height": touch }],
    [".shortcut-help > header button", { width: touch, height: touch }],
    [".skill-editor-dialog > header button", { width: touch, height: touch }],
    [".skill-editor-dialog > footer button", { "min-height": touch }],
    [".workspace-actions-menu > button", { "min-height": touch }],
    [".workspace-profile-settings select", { "min-height": touch }],
    [".gate-profile-select select", { "min-height": touch }],
    [".composer textarea", { "min-height": touch }],
  ];
  for (const [selector, expected] of rules) {
    const values = ruleDeclarations(root, selector, "(max-width: 680px)");
    for (const [property, value] of Object.entries(expected)) {
      if (values.get(property) !== value) {
        throw new Error(`${selector} must preserve a 44px mobile touch target; expected ${property}: ${value}`);
      }
    }
  }
  const goalRoot = postcss.parse(goalSource, { from: "src/goal-styles.css" });
  const goalRules = [
    [".goal-new-button", { height: touch }],
    [".goal-field input", { height: touch }],
    [".goal-criterion-editor>input", { height: touch }],
    [".goal-required", { "min-height": touch }],
    [".goal-icon-action", { width: touch, height: touch }],
    [".goal-secondary-action", { "min-height": touch }],
    [".goal-form-actions>button:not(.memory-primary)", { "min-height": touch }],
    [".goal-run-links button", { "min-height": touch }],
    [".goal-management button", { "min-height": touch }],
  ];
  for (const [selector, expected] of goalRules) {
    const values = ruleDeclarations(goalRoot, selector, "(max-width: 760px)");
    for (const [property, value] of Object.entries(expected)) {
      if (values.get(property) !== value) {
        throw new Error(`${selector} must preserve a 44px mobile touch target; expected ${property}: ${value}`);
      }
    }
  }
}

function assertWorkspaceRailDensity(source) {
  const root = postcss.parse(source, { from: "src/layout.css" });
  let desktopActionReserve;
  let genericUnreadReserve;
  let unreadReserve;
  root.walkRules((rule) => {
    if (rule.selectors.includes(".workspace-select")) {
      for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
        if (parent.type === "atrule" && parent.name === "media") return;
      }
      for (const node of rule.nodes) {
        if (node.type === "decl" && node.prop === "padding-right") desktopActionReserve = node.value.trim();
      }
    }
    if (rule.selectors.includes(".workspace-item strong")) {
      for (const node of rule.nodes) {
        if (node.type === "decl" && node.prop === "padding-right") genericUnreadReserve = node.value.trim();
      }
    }
    if (rule.selectors.includes(".workspace-item.unread strong")) {
      for (const node of rule.nodes) {
        if (node.type === "decl" && node.prop === "padding-right") unreadReserve = node.value.trim();
      }
    }
  });
  if (desktopActionReserve !== "var(--space-40)") {
    throw new Error("Desktop Workspace rows must reserve only --space-40 for the compact action so short names remain readable");
  }
  if (genericUnreadReserve !== undefined || unreadReserve !== "var(--space-10)") {
    throw new Error("Workspace titles must reserve indicator space only on unread rows so compact rails do not truncate ordinary names");
  }

  const expectedCollapsedGeometry = new Map([
    [".workspace-rail.collapsed", new Map([["padding", "var(--space-12) var(--space-10)"]])],
    [".audit-panel.collapsed", new Map([["padding-inline", "var(--space-12)"]])],
    [".audit-panel.collapsed .audit-panel-heading", new Map([["padding", "0"]])],
    [".workspace-rail.collapsed .brand", new Map([["padding", "0 0 var(--space-12)"]])],
    [".workspace-rail.collapsed .new-workspace", new Map([
      ["width", "var(--control-xl)"],
      ["height", "var(--control-xl)"],
      ["padding", "0"],
    ])],
    [".workspace-rail.collapsed .brand .icon-button", new Map([
      ["width", "var(--control-xl)"],
      ["height", "var(--control-xl)"],
      ["margin", "0"],
    ])],
    [".workspace-rail.collapsed .workspace-item", new Map([["min-height", "var(--control-xl)"]])],
    [".workspace-rail.collapsed .workspace-select", new Map([
      ["min-height", "var(--control-xl)"],
      ["padding", "0"],
    ])],
    [".workspace-rail.collapsed .workspace-avatar", new Map([
      ["top", "var(--space-8)"],
      ["left", "var(--space-8)"],
    ])],
  ]);
  const obsoleteBaseGeometry = new Map([
    [".workspace-rail.collapsed", new Set(["padding", "padding-block", "padding-inline", "padding-top", "padding-right", "padding-bottom", "padding-left"])],
    [".audit-panel.collapsed", new Set(["padding", "padding-block", "padding-inline", "padding-top", "padding-right", "padding-bottom", "padding-left"])],
    [".audit-panel.collapsed .audit-panel-heading", new Set(["padding", "padding-block", "padding-inline", "padding-top", "padding-right", "padding-bottom", "padding-left"])],
    [".workspace-rail.collapsed .brand", new Set(["padding", "padding-block", "padding-inline", "padding-top", "padding-right", "padding-bottom", "padding-left"])],
    [".workspace-rail.collapsed .brand-mark", new Set(["width", "height"])],
    [".workspace-rail.collapsed .new-workspace", new Set(["width", "height", "padding", "padding-inline"])],
    [".workspace-rail.collapsed .brand .icon-button", new Set(["width", "height", "margin", "margin-left"])],
    [".workspace-rail.collapsed .workspace-list", new Set(["margin-top"])],
    [".workspace-rail.collapsed .workspace-item", new Set(["min-height"])],
    [".workspace-rail.collapsed .workspace-select", new Set(["min-height", "padding", "padding-inline", "padding-left", "padding-right"])],
    [".workspace-rail.collapsed .workspace-avatar", new Set(["top", "left"])],
  ]);
  const foundCollapsedGeometry = new Map();
  root.walkRules((rule) => {
    let desktopCollapsedRule = false;
    let sublayer;
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "media" && parent.params.replace(/\s+/g, " ").trim() === "(min-width: 981px)") {
        desktopCollapsedRule = true;
      }
      if (parent.type === "atrule" && parent.name === "layer" && ["base", "refinement"].includes(parent.params.trim())) {
        sublayer = parent.params.trim();
      }
    }
    if (!desktopCollapsedRule) return;
    for (const rawSelector of rule.selectors) {
      const selector = rawSelector.trim();
      const expected = expectedCollapsedGeometry.get(selector);
      const obsoleteProperties = obsoleteBaseGeometry.get(selector);
      if (!expected && !obsoleteProperties) continue;
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        if (sublayer === "base" && obsoleteProperties?.has(node.prop)) {
          throw new Error(`${selector} ${node.prop} is obsolete collapsed geometry in layout.base; keep authoritative component geometry in layout.refinement`);
        }
        if (!expected?.has(node.prop)) continue;
        if (sublayer !== "refinement") {
          throw new Error(`${selector} ${node.prop} must be owned by layout.refinement so generic component geometry cannot override it`);
        }
        const key = `${selector}\n${node.prop}`;
        if (foundCollapsedGeometry.has(key)) {
          throw new Error(`${selector} duplicates collapsed ${node.prop} geometry; keep one authoritative refinement declaration`);
        }
        foundCollapsedGeometry.set(key, node.value.trim());
      }
    }
  });
  for (const [selector, declarations] of expectedCollapsedGeometry) {
    for (const [property, expected] of declarations) {
      const actual = foundCollapsedGeometry.get(`${selector}\n${property}`);
      if (actual !== expected) {
        throw new Error(`${selector} must preserve collapsed ${property}: ${expected}; found ${actual ?? "no refinement declaration"}`);
      }
    }
  }
}

function assertRefinementStateAppearance(source) {
  const root = postcss.parse(source, { from: "src/design-system.css" });
  const expectations = [
    [".message-copy", "opacity", "0", ""],
    [".message-copy", "opacity", "var(--opacity-subtle)", "(hover: none), (pointer: coarse)"],
    [".message-copy", "opacity", "var(--opacity-muted)", "(max-width: 680px)"],
    [".message:hover .message-copy", "opacity", "1", ""],
    [".message:focus-within .message-copy", "opacity", "1", ""],
    [".message-copy:focus-visible", "opacity", "1", ""],
    [".message-copy.copied", "opacity", "1", ""],
    [".message-copy.failed", "opacity", "1", ""],
    [".gate-profile-select select:focus-visible", "outline", "0", ""],
    [".gate-profile-select select:focus-visible", "border-color", "var(--border-accent)", ""],
    [".gate-profile-select select:focus-visible", "box-shadow", "var(--shadow-focus)", ""],
    [".thinking-step.redacted .run-step-content", "color", "var(--foreground-muted)", ""],
    [".thinking-step.redacted .run-step-content", "font-style", "italic", ""],
  ];
  for (const [selector, property, expected, expectedMedia] of expectations) {
    const matches = ruleDeclarationEntries(root, selector, expectedMedia)
      .filter((entry) => entry.property === property);
    if (matches.length !== 1 || matches[0].value !== expected || matches[0].sublayer !== "refinement") {
      const actual = matches.length === 0
        ? "no declaration"
        : matches.map((match) => `${match.sublayer ?? "unlayered"}:${match.value}`).join(", ");
      const context = expectedMedia ? ` in @media ${expectedMedia}` : "";
      throw new Error(`${selector} ${property}${context} must have one authoritative design.refinement declaration ${expected}; found ${actual}`);
    }
  }
}

function assertSharedInteractionGrammar(designSource, goalSource) {
  const roots = new Map([
    ["src/design-system.css", postcss.parse(designSource, { from: "src/design-system.css" })],
    ["src/goal-styles.css", postcss.parse(goalSource, { from: "src/goal-styles.css" })],
  ]);
  const expectedTransition = "border-color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)";
  for (const selector of ["button", "input", "textarea", "select", "summary"]) {
    const matches = ruleDeclarationEntries(roots.get("src/design-system.css"), selector, null)
      .filter((declaration) => declaration.property === "transition");
    if (matches.length !== 1 || matches[0].value !== expectedTransition || matches[0].sublayer !== "baseline") {
      throw new Error(`${selector} must inherit the one authoritative design.baseline control transition`);
    }
  }

  const expectations = [
    [designSource, "src/design-system.css", "button:active:not(:disabled)", "transform", "translateY(var(--space-hairline))"],
    [designSource, "src/design-system.css", "summary:active", "transform", "translateY(var(--space-hairline))"],
    [designSource, "src/design-system.css", ".tool-call summary:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".run-contract > summary:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".audit-disclosure > summary:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".gate-evaluation > summary:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".run-step > summary:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".workspace-switcher-results > button:hover", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".skill-editor-dialog > footer button:not(.primary):hover:not(:disabled)", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".skill-editor-dialog > footer button.primary:hover:not(:disabled)", "background", "var(--accent-hover)"],
    [designSource, "src/design-system.css", ".artifact-modal-actions button:hover:not(:disabled)", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".memory-modal footer > div > button:not(.memory-primary):hover:not(:disabled)", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".memory-inline-actions button:not(.memory-primary):hover:not(:disabled)", "background", "var(--surface-hover)"],
    [designSource, "src/design-system.css", ".history-context button:hover", "background", "var(--surface-hover)"],
    [goalSource, "src/goal-styles.css", ".goal-form-actions>button:not(.memory-primary):hover:not(:disabled)", "background", "var(--surface-hover)"],
    [goalSource, "src/goal-styles.css", ".goal-disclosure>summary:hover", "background", "var(--surface-hover)"],
    [goalSource, "src/goal-styles.css", ".goal-roadmap-copy details summary:hover", "color", "var(--foreground-strong)"],
    [goalSource, "src/goal-styles.css", ".goal-management button:hover:not(:disabled)", "background", "var(--surface-hover)"],
    [goalSource, "src/goal-styles.css", ".goal-management button.danger-quiet:hover:not(:disabled)", "border-color", "var(--border-danger)"],
  ];
  for (const [, file, selector, property, expected] of expectations) {
    const matches = ruleDeclarationEntries(roots.get(file), selector, null).filter((declaration) => declaration.property === property);
    if (matches.length !== 1 || matches[0].value !== expected) {
      throw new Error(`${selector} must preserve the shared interaction grammar; expected ${property}: ${expected}`);
    }
  }

  const designRoot = roots.get("src/design-system.css");
  const allowedActiveTransforms = new Set(["button:active:not(:disabled)", "summary:active", ".jump-to-latest:active"]);
  const retiredLocalTransitions = new Set([
    ".gate-profile-select select",
    ".user-input-card button",
    ".workspace-menu-toggle",
    ".skill-menu-toggle",
    ".run-status-control",
    ".skill-drop-target",
    ".jump-to-latest",
  ]);
  designRoot.walkRules((rule) => {
    for (const node of rule.nodes) {
      if (node.type !== "decl") continue;
      if (node.prop === "transform" && rule.selectors.some((selector) => selector.includes(":active") && !allowedActiveTransforms.has(selector.trim()))) {
        throw new Error(`src/design-system.css:${node.source.start.line} duplicates the shared active transform; keep only composed-position exceptions`);
      }
      if (node.prop === "transition" && rule.selectors.some((selector) => retiredLocalTransitions.has(selector.trim()))) {
        throw new Error(`src/design-system.css:${node.source.start.line} restores a component-local control transition; use the shared control transition`);
      }
    }
  });
}

function assertShellGeometryTokens(source, themeTokens) {
  const expectedTokens = new Map([
    ["workspace-rail-width", "232px"],
    ["workspace-rail-width-compact", "220px"],
    ["workspace-rail-width-collapsed", "60px"],
    ["audit-panel-width", "304px"],
    ["audit-panel-width-compact", "284px"],
  ]);
  for (const [tokenName, expected] of expectedTokens) {
    const actual = themeTokens.get(tokenName);
    if (actual !== expected) throw new Error(`--${tokenName} must remain ${expected}; found ${actual ?? "undefined"}`);
  }
  const root = postcss.parse(source, { from: "src/layout.css" });
  const responsiveContexts = new Set();
  root.walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.trim().startsWith(".app-shell"))) return;
    for (const node of rule.nodes) {
      if (node.type !== "decl" || node.prop !== "grid-template-columns") continue;
      if (/\d+(?:\.\d+)?px\b/i.test(node.value)) {
        throw new Error(`src/layout.css:${node.source.start.line} App shell columns must use semantic geometry tokens instead of raw pixels`);
      }
      for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
        if (parent.type === "atrule" && parent.name === "media") responsiveContexts.add(parent.params.replace(/\s+/g, " ").trim());
      }
    }
  });
  const expectedContexts = new Set(["(max-width: 1280px) and (min-width: 981px)", "(min-width: 1281px)"]);
  if (responsiveContexts.size !== expectedContexts.size || [...responsiveContexts].some((context) => !expectedContexts.has(context))) {
    throw new Error(`Responsive App shell columns must keep disjoint compact and regular breakpoints; found ${[...responsiveContexts].join(", ")}`);
  }
}

function rejectObsoleteArtifactLinkSelectors(layoutSource, designSource) {
  for (const [file, source] of [["src/layout.css", layoutSource], ["src/design-system.css", designSource]]) {
    const root = postcss.parse(source, { from: file });
    root.walkRules((rule) => {
      if (rule.selectors.some((selector) => selector.includes(".artifact-row > a") || selector.includes(".artifact-modal-actions a"))) {
        throw new Error(`${file}:${rule.source.start.line} styles the retired Artifact link markup; use .artifact-open and .artifact-download button roles`);
      }
    });
  }
}

const taskRunStatusTones = new Map([
  ["running", "info"],
  ["waiting_input", "warning"],
  ["completed", "success"],
  ["blocked", "warning"],
  ["interrupted", "danger"],
  ["cancelled", "danger"],
  ["failed", "danger"],
]);

function taskRunOperationalColorRules(designSource) {
  const abiSource = read("packages/abi/src/channel/v1/session-schemas.ts", repositoryRoot);
  const union = abiSource.match(/export const TaskRunStatusSchema = Type\.Union\(\[([\s\S]*?)\]\);/);
  if (!union) throw new Error("Could not read TaskRunStatusSchema from the ABI source");
  const statuses = [...union[1].matchAll(/Type\.Literal\("([a-z_]+)"\)/g)].map((match) => match[1]);
  const configured = [...taskRunStatusTones.keys()];
  if (JSON.stringify([...statuses].sort()) !== JSON.stringify([...configured].sort())) {
    throw new Error(`TaskRun semantic tones must exactly cover the ABI status set; ABI=${statuses.join(",")}, mapped=${configured.join(",")}`);
  }

  const statusSet = new Set(statuses);
  const statusSurface = /\.(?:workspace-run-status|run-status-control|phase-badge|history-status|workspace-switcher-status|collapsed-audit-dot|workspace-tooltip-status)\.([a-z_]+)/;
  const root = postcss.parse(designSource, { from: "src/design-system.css" });
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      const status = selector.match(statusSurface)?.[1];
      if (status && !statusSet.has(status)) {
        throw new Error(`${selector} styles obsolete or unsupported TaskRun status ${status}`);
      }
    }
  });

  const surfaces = [
    ["run-status-control", " > span", "background"],
    ["phase-badge", "", "color"],
    ["history-status", "", "background"],
    ["workspace-switcher-status", "", "color"],
    ["collapsed-audit-dot", "", "background"],
    ["workspace-tooltip-status", "", "background"],
  ];
  return statuses.flatMap((status) => {
    const tone = taskRunStatusTones.get(status);
    const rules = surfaces.map(([surface, suffix, property]) => [
      "src/design-system.css", `.${surface}.${status}${suffix}`, property, `var(--${tone})`,
    ]);
    rules.push(status === "running"
      ? ["src/design-system.css", ".workspace-run-status.running > svg", "color", `var(--${tone})`]
      : ["src/design-system.css", `.workspace-run-status.${status} .workspace-status-dot`, "background", `var(--${tone})`]);
    return rules;
  });
}

function assertSemanticColorRoles(designSource, goalSource) {
  const roots = new Map([
    ["src/design-system.css", postcss.parse(designSource, { from: "src/design-system.css" })],
    ["src/goal-styles.css", postcss.parse(goalSource, { from: "src/goal-styles.css" })],
  ]);
  const rules = [
    ["src/design-system.css", ".eyebrow", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".pulse", "background", "var(--info)"],
    ...taskRunOperationalColorRules(designSource),
    ["src/design-system.css", ".turn-memory.running", "color", "var(--info)"],
    ["src/design-system.css", ".turn-memory.completed", "color", "var(--success)"],
    ["src/design-system.css", ".turn-memory.queued", "color", "var(--warning)"],
    ["src/design-system.css", ".turn-memory.failed", "color", "var(--danger)"],
    ["src/design-system.css", ".continuation-status.running", "color", "var(--info)"],
    ["src/design-system.css", ".continuation-status.completed", "color", "var(--success)"],
    ["src/design-system.css", ".continuation-status.blocked", "color", "var(--warning)"],
    ["src/design-system.css", ".continuation-status.failed", "color", "var(--danger)"],
    ["src/design-system.css", ".gate-standard-grid .audit-pass", "color", "var(--success)"],
    ["src/design-system.css", ".criterion-row strong", "color", "var(--success)"],
    ["src/design-system.css", ".artifact-row > svg", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".supervisor-verdict > div:first-child svg", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".active-run-strip strong", "color", "var(--info)"],
    ["src/design-system.css", ".active-run-strip svg", "color", "var(--info)"],
    ["src/design-system.css", ".tier-dot.warm", "background", "var(--foreground-subtle)"],
    ["src/design-system.css", ".intent-badge.steer_active", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".intent-badge.update_active_context", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".skill-snapshot-note svg", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".workspace-switcher > header span", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".shortcut-help > header > span", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".shortcut-help > header > span", "background", "var(--surface-muted)"],
    ["src/design-system.css", ".memory-health-ledger dt", "color", "var(--foreground-muted)"],
    ["src/design-system.css", ".memory-job-state.info .memory-job-dot", "background", "var(--info)"],
    ["src/design-system.css", ".memory-job-state.success .memory-job-dot", "background", "var(--success)"],
    ["src/design-system.css", ".memory-job-state.warning .memory-job-dot", "background", "var(--warning)"],
    ["src/design-system.css", ".memory-job-state.danger .memory-job-dot", "background", "var(--danger)"],
    ["src/design-system.css", ".artifact-download", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".artifact-open:hover strong", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".artifact-download:hover", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".topbar h1 button:hover", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".workspace-switcher-pin", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".workspace-switcher-current", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".workspace-avatar.custom", "filter", "grayscale(1)", "refinement"],
    ["src/design-system.css", ".workspace-switcher-avatar.custom", "filter", "grayscale(1)", "refinement"],
    ["src/design-system.css", ".workspace-avatar-options button", "filter", "grayscale(1)", "refinement"],
    ["src/design-system.css", ".message-copy:hover", "color", "var(--foreground)", "refinement"],
    ["src/design-system.css", ".memory-load-more:hover:not(:disabled)", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".workspace-navigation-empty button", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".workspace-navigation-empty button:hover", "color", "var(--foreground)", "refinement"],
    ["src/design-system.css", ".starter-prompts button:hover > svg", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".assistant-step.live", "box-shadow", "var(--shadow-edge-info)", "refinement"],
    ["src/design-system.css", ".thinking-step.live", "box-shadow", "var(--shadow-edge-info)", "refinement"],
    ["src/design-system.css", ".run-status-note.warning", "color", "var(--warning)", "refinement"],
    ["src/design-system.css", ".run-status-note.warning", "box-shadow", "var(--shadow-edge-warning)", "refinement"],
    ["src/design-system.css", ".run-status-note.danger", "color", "var(--danger)", "refinement"],
    ["src/design-system.css", ".run-status-note.danger", "box-shadow", "var(--shadow-edge-danger)", "refinement"],
    ["src/design-system.css", ".inbox-actions button:hover", "color", "var(--foreground-strong)", "refinement"],
    ["src/design-system.css", ".inbox-actions button.run-now", "color", "var(--accent)", "refinement"],
    ["src/design-system.css", ".memory-heading-icon", "border", "var(--stroke-hairline) solid var(--border)", "refinement"],
    ["src/design-system.css", ".icon-button.danger", "color", "var(--danger)", "refinement"],
    ["src/design-system.css", ".icon-button.danger", "border-color", "var(--border-danger)", "refinement"],
    ["src/design-system.css", ".icon-button.danger:hover", "background", "var(--surface-hover)", "refinement"],
    ["src/design-system.css", ".queue-drag-handle", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".inbox-item > button:last-child", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".memory-section-heading > button", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".load-older", "color", "var(--foreground-muted)", "refinement"],
    ["src/design-system.css", ".load-older:hover:not(:disabled)", "color", "var(--foreground)", "refinement"],
    ["src/design-system.css", ".user-input-card button", "color", "var(--accent-contrast)", "refinement"],
    ["src/goal-styles.css", ".goal-nav-dot", "background", "var(--foreground-muted)"],
    ["src/goal-styles.css", ".goal-nav-dot.info", "background", "var(--info)"],
    ["src/goal-styles.css", ".goal-nav-dot.warning", "background", "var(--warning)"],
    ["src/goal-styles.css", ".goal-nav-dot.success", "background", "var(--success)"],
    ["src/goal-styles.css", ".goal-nav-dot.danger", "background", "var(--danger)"],
    ["src/goal-styles.css", ".goal-status-badge", "color", "var(--foreground-muted)"],
    ["src/goal-styles.css", ".goal-status-badge.info", "color", "var(--info)"],
    ["src/goal-styles.css", ".goal-status-badge.warning", "color", "var(--warning)"],
    ["src/goal-styles.css", ".goal-status-badge.success", "color", "var(--success)"],
    ["src/goal-styles.css", ".goal-status-badge.danger", "color", "var(--danger)"],
    ["src/goal-styles.css", ".goal-roadmap-leading", "color", "var(--foreground-muted)"],
    ["src/goal-styles.css", ".goal-roadmap-item.running .goal-roadmap-leading", "color", "var(--info)"],
    ["src/goal-styles.css", ".goal-roadmap-item.running .goal-roadmap-action em", "color", "var(--info)"],
    ["src/goal-styles.css", ".goal-roadmap-item.completed .goal-roadmap-leading", "color", "var(--success)"],
    ["src/goal-styles.css", ".goal-roadmap-item.completed .goal-roadmap-action em", "color", "var(--success)"],
    ["src/goal-styles.css", ".goal-roadmap-item.blocked .goal-roadmap-leading", "color", "var(--warning)"],
    ["src/goal-styles.css", ".goal-roadmap-item.blocked .goal-roadmap-action em", "color", "var(--warning)"],
    ["src/goal-styles.css", ".goal-section-heading>strong", "color", "var(--foreground-strong)"],
    ["src/goal-styles.css", ".goal-next-icon", "color", "var(--foreground-strong)"],
  ];
  for (const [file, selector, property, expected, expectedSublayer] of rules) {
    const declaration = ruleDeclarationEntries(roots.get(file), selector, null)
      .filter((entry) => entry.property === property)
      .at(-1);
    const actual = declaration?.value;
    const actualSublayer = declaration?.sublayer;
    if (actual !== expected) {
      throw new Error(`${selector} must preserve the semantic color role ${property}: ${expected}; found ${actual ?? "no declaration"}`);
    }
    if (expectedSublayer && actualSublayer !== expectedSublayer) {
      throw new Error(`${selector} ${property} must be owned by the ${expectedSublayer} sublayer so later generic rules cannot override it`);
    }
  }
}

function assertStyleEntrypoints() {
  const styleFiles = readdirSync(sourceRoot).filter((name) => name.endsWith(".css")).sort();
  if (JSON.stringify(styleFiles) !== JSON.stringify(expectedStyleFiles)) {
    throw new Error(`Web style files must be exactly ${expectedStyleFiles.join(", ")}; found ${styleFiles.join(", ")}`);
  }
  const cascade = read("cascade.css").trim();
  if (cascade !== "@layer layout, design, features;") {
    throw new Error("src/cascade.css must declare the canonical layout, design, features layer order");
  }
  const mainModule = read("main.tsx");
  const styleImports = [...mainModule.matchAll(/import\s+"\.\/([^"\n]+\.css)";/g)].map((match) => match[1]);
  if (JSON.stringify(styleImports) !== JSON.stringify(expectedStyleImports)) {
    throw new Error(`src/main.tsx must import styles in canonical order: ${expectedStyleImports.join(", ")}`);
  }
  const styleReferences = readdirSync(sourceRoot)
    .filter((name) => /\.(?:ts|tsx)$/.test(name))
    .flatMap((name) => [...read(name).matchAll(/["']([^"'\n]+\.css)["']/g)].map((match) => `${name}:${match[1]}`));
  const expectedReferences = expectedStyleImports.map((name) => `main.tsx:./${name}`);
  if (JSON.stringify(styleReferences.sort()) !== JSON.stringify(expectedReferences.sort())) {
    throw new Error(`Web modules may only reference the canonical styles from src/main.tsx; found ${styleReferences.join(", ")}`);
  }
}

function assertCanonicalNavigationLabels(source) {
  const expected = [
    'aria-label="Open workspace sidebar"',
    'aria-label="Close workspace sidebar"',
    'aria-label="Close audit panel"',
  ];
  for (const label of expected) {
    if (!source.includes(label)) throw new Error(`Web navigation must preserve the canonical accessible label ${label}`);
  }
  const retired = [
    'aria-label="Open sessions"',
    'aria-label="Close sessions"',
    'aria-label="Close task panel"',
    'title="Expand sidebar"',
    'title="Collapse sidebar"',
  ];
  for (const label of retired) {
    if (source.includes(label)) throw new Error(`Web navigation uses retired or ambiguous terminology: ${label}`);
  }
  if (source.includes(">On demand<")) {
    throw new Error("The visible Audit panel must not repeat static availability as an On demand eyebrow");
  }
  if (source.includes("· db v")) {
    throw new Error("The Workspace sidebar must not expose the static database schema revision as persistent navigation chrome");
  }
  if (source.includes('"Local control plane"')) {
    throw new Error("The Workspace sidebar must not present static local-runtime copy as a live health indicator");
  }
  if (source.includes('"Workspace ready"')) {
    throw new Error("The empty Workspace must not repeat the Composer Ready state as a decorative eyebrow");
  }
  if (source.includes('"Supervisor inbox"')) {
    throw new Error("The idle Composer must show its current Ready state without repeating the static Supervisor inbox capability");
  }
}

function rejectRetiredShellVisualNames(sources) {
  const retiredClass = /\b(?:new-session|run-panel|panel-section|section-title|(?<!audit-)panel-(?:heading|collapse)|session-(?:rail|list|item|select|title-input|meta|emoji|search|group|group-label|more|menu-scrim|context-menu|emoji-options|skeletons|search-empty|editor)|sessionSearch|setSessionSearch|pinnedSessionIds|setPinnedSessionIds|lastSeenBySession|setLastSeenBySession|sessionActivityBaseline|setSessionActivityBaseline|sessionMenu(?:Id|Position)|setSessionMenu(?:Id|Position)|mergeSessionActivityBaseline|WorkspaceSession(?:Authority|Token)|replaceWorkspaceSession|sessionRailRef|renamingSessionId|sessionTitleDraft|setSessionTitleDraft|selectedSession|sessionsLoading)\b/;
  for (const [file, source] of sources) {
    const match = retiredClass.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split("\n").length;
    throw new Error(`${file}:${line} uses a retired shell visual or presentation name; navigation uses canonical workspace-* and audit-* terminology`);
  }
}

assertStyleEntrypoints();
const layout = read("layout.css");
const goals = read("goal-styles.css");
const designSystem = read("design-system.css");
assertLayerOwned("src/layout.css", layout, "layout");
assertLayerOwned("src/design-system.css", designSystem, "design");
assertLayerOwned("src/goal-styles.css", goals, "features");
assertLayoutSublayers("src/layout.css", layout);
assertDesignSublayers("src/design-system.css", designSystem);
rejectLayoutAppearance("src/layout.css", layout);
rejectDesignMechanics("src/design-system.css", designSystem);
rejectRawColors("src/layout.css", layout);
rejectRawColors("src/goal-styles.css", goals);
rejectLocalColorMix("src/layout.css", layout);
rejectLocalColorMix("src/goal-styles.css", goals);
rejectLocalFontStacks("src/layout.css", layout);
rejectLocalFontStacks("src/design-system.css", designSystem);
rejectLocalFontStacks("src/goal-styles.css", goals);
rejectBroadSemanticFills("src/design-system.css", designSystem);
rejectBroadSemanticFills("src/goal-styles.css", goals);
rejectGlassEffects("src/layout.css", layout);
rejectGlassEffects("src/design-system.css", designSystem);
rejectGlassEffects("src/goal-styles.css", goals);
rejectRawSmallSquares("src/layout.css", layout);
rejectRawSmallSquares("src/design-system.css", designSystem);
rejectRawSmallSquares("src/goal-styles.css", goals);
rejectRawDensityHeights("src/layout.css", layout);
rejectRawDensityHeights("src/design-system.css", designSystem);
rejectRawDensityHeights("src/goal-styles.css", goals);
rejectRawMicroGeometry("src/layout.css", layout);
rejectRawMicroGeometry("src/design-system.css", designSystem);
rejectRawMicroGeometry("src/goal-styles.css", goals);
rejectOverrideImportant("src/layout.css", layout);
rejectOverrideImportant("src/design-system.css", designSystem);
rejectOverrideImportant("src/goal-styles.css", goals);
rejectCrossLayerShadows([
  ["src/layout.css", layout],
  ["src/design-system.css", designSystem],
  ["src/goal-styles.css", goals],
]);
assertStarterPromptLedger(layout, designSystem);
assertEvidenceLedgers(designSystem);
assertInterfaceLedgers(layout, designSystem, goals);
assertWorkspaceSwitcherLayout(layout);
assertCollapsedWorkspaceTooltipBehavior(designSystem);
assertMobileTouchTargets(layout, goals);
assertWorkspaceRailDensity(layout);
assertRefinementStateAppearance(designSystem);
assertSharedInteractionGrammar(designSystem, goals);
rejectObsoleteArtifactLinkSelectors(layout, designSystem);
assertSemanticColorRoles(designSystem, goals);

const designLight = block(designSystem, ":root");
const designDark = block(designSystem, ':root[data-theme="dark"]');
const designLightTokens = tokens(designLight.body);
assertReadableThemeContrast(designLightTokens, tokens(designDark.body));
assertReadableTypeScale(designLightTokens);
assertCanonicalTokenAliases(designLightTokens);
assertSharedContentMeasures(layout, goals, designLightTokens);
assertShellGeometryTokens(layout, designLightTokens);
const designComponents = designSystem.slice(designDark.end);
rejectRawColors("src/design-system.css after theme tokens", designComponents);
rejectLocalColorMix("src/design-system.css after theme tokens", designComponents);

const componentCss = `${layout}\n${designSystem}\n${goals}`;
const definedTokens = new Set([...componentCss.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
const usedTokens = new Set([...componentCss.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
const unusedTokens = [...definedTokens].filter((name) => !usedTokens.has(name));
if (unusedTokens.length) throw new Error(`Unused style tokens: ${unusedTokens.map((name) => `--${name}`).join(", ")}`);

const componentSource = readdirSync(sourceRoot)
  .filter((name) => /\.(?:ts|tsx)$/.test(name))
  .map((name) => read(name))
  .join("\n");
assertCanonicalNavigationLabels(componentSource);
rejectRetiredShellVisualNames([
  ["src/layout.css", layout],
  ["src/design-system.css", designSystem],
  ["src/goal-styles.css", goals],
  ["src components", componentSource],
]);
const iconScaleSource = read("icon-size.ts");
const iconScale = [...iconScaleSource.matchAll(/^\s*([a-z]+):\s*(\d+),$/gm)]
  .map(([, name, size]) => [name, Number(size)]);
const expectedIconScale = [["micro", 10], ["xs", 12], ["sm", 14], ["md", 16], ["lg", 18], ["xl", 20], ["hero", 24]];
if (JSON.stringify(iconScale) !== JSON.stringify(expectedIconScale)) {
  throw new Error("icon-size.ts must keep the shared 10/12/14/16/18/20/24 icon ladder");
}
for (const name of readdirSync(sourceRoot).filter((entry) => entry.endsWith(".tsx"))) {
  const source = read(name);
  const match = /<[A-Z][A-Za-z0-9.]*\b[^>]*\bsize=\{\d+\}/.exec(source);
  if (!match) continue;
  const line = source.slice(0, match.index).split("\n").length;
  throw new Error(`${name}:${line} uses a raw component icon size; use ICON_SIZE from icon-size.ts`);
}
const cssWithoutComments = componentCss.replace(/\/\*[\s\S]*?\*\//g, "");
for (const match of cssWithoutComments.matchAll(/(?:^|[;{}])\s*([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
  const [, property, value] = match;
  if ((property === "font-size" || property === "font") && /\d+(?:\.\d+)?px\b/.test(value)) {
    throw new Error(`${property} must use the shared type scale: ${value.trim()}`);
  }
  if (property === "font-weight" && !/^(?:inherit|initial|unset|revert(?:-layer)?|var\(--weight-[a-z0-9-]+\))$/i.test(value.trim())) {
    throw new Error(`font-weight must use the shared weight scale: ${value.trim()}`);
  }
  if (property === "font" && /^(?:\d+(?:\.\d+)?|bold(?:er)?|lighter|normal)\s/i.test(value.trim())) {
    throw new Error(`font shorthand must use the shared weight scale: ${value.trim()}`);
  }
  if (property === "letter-spacing" && !/^(?:0|normal|inherit|initial|unset|revert(?:-layer)?|var\(--tracking-[a-z0-9-]+\))$/i.test(value.trim())) {
    throw new Error(`letter-spacing must use the shared tracking scale: ${value.trim()}`);
  }
  if (property === "text-transform" && value.trim().toLowerCase() === "capitalize") {
    throw new Error("text-transform: capitalize corrupts identifiers and enum labels; format sentence case in view logic");
  }
  if (property === "line-height" && !/^(?:normal|inherit|initial|unset|revert(?:-layer)?|var\(--leading-[a-z0-9-]+\))$/i.test(value.trim())) {
    throw new Error(`line-height must use the shared leading scale: ${value.trim()}`);
  }
  if (property === "font") {
    const shorthandLeading = value.match(/\/\s*([^\s;]+)/)?.[1];
    if (shorthandLeading && !/^var\(--leading-[a-z0-9-]+\)$/i.test(shorthandLeading)) {
      throw new Error(`font shorthand must use the shared leading scale: ${value.trim()}`);
    }
  }
  if (property === "opacity" && !/^(?:0|1|inherit|initial|unset|revert(?:-layer)?|var\(--opacity-[a-z0-9-]+\))$/i.test(value.trim())) {
    throw new Error(`opacity must use the shared state scale: ${value.trim()}`);
  }
  if (property === "z-index" && !/^(?:auto|inherit|initial|unset|revert(?:-layer)?|var\(--z-[a-z0-9-]+\)|calc\(var\(--z-[a-z0-9-]+\)\s*[+-]\s*\d+\))$/i.test(value.trim())) {
    throw new Error(`z-index must use the shared layer scale: ${value.trim()}`);
  }
  if (/^(?:border(?:-(?:top|right|bottom|left))?|outline)$/.test(property) && /^\d+(?:\.\d+)?px\s/i.test(value.trim())) {
    throw new Error(`${property} width must use the shared stroke scale: ${value.trim()}`);
  }
  if (property === "outline-offset" && /-?\d+(?:\.\d+)?px\b/i.test(value)) {
    throw new Error(`outline-offset must use the shared spacing scale: ${value.trim()}`);
  }
  if (property === "border-radius" && /\d+(?:\.\d+)?px\b/.test(value)) {
    throw new Error(`border-radius must use the shared radius scale: ${value.trim()}`);
  }
  if (property === "box-shadow" && !/^(?:none|var\(--[a-z0-9-]+\)(?:\s*,\s*var\(--[a-z0-9-]+\))*)$/i.test(value.trim())) {
    throw new Error(`box-shadow must use the shared depth scale: ${value.trim()}`);
  }
  if (["gap", "row-gap", "column-gap"].includes(property) && /\d+(?:\.\d+)?px\b/.test(value)) {
    throw new Error(`${property} must use the shared spacing scale: ${value.trim()}`);
  }
  if (/^(?:padding|margin)(?:-|$)/.test(property) && /-?\d+(?:\.\d+)?px\b/.test(value)) {
    throw new Error(`${property} must use the shared spacing scale: ${value.trim()}`);
  }
  if (/^(?:transition|animation)(?:-|$)/.test(property)) {
    const rawDurations = [...value.matchAll(/(?:\d*\.)?\d+(?:ms|s)\b/g)]
      .map((duration) => duration[0])
      .filter((duration) => duration !== "0s" && duration !== "0.01ms");
    if (rawDurations.length) throw new Error(`${property} must use the shared motion scale: ${value.trim()}`);
  }
}

const compactControlSelector = /(?:\b(?:button|input|select|textarea)\b|\.(?:icon-button|new-workspace|resume-button|workspace-title-input|workspace-search|workspace-more|jump-to-latest|workspace-menu-toggle|skill-menu-toggle|run-status-control|memory-search|memory-primary|goal-new-button|goal-icon-action|goal-secondary-action)\b)/i;
const nonControlDescendant = /(?:>|\s)(?:span|kbd|i|\.skill-revision-badge|\.skill-select-box)\s*$/i;
const squareControlSelector = /(?:\.icon-button\b|\.new-workspace\b|\.inbox-item\s+button\b|\.skill-row-actions\s+button\b|\.skill-editor-dialog\s*>\s*header\s+button\b|\.shortcut-help\s*>\s*header\s+button\b|\.workspace-switcher\s*>\s*header\s+button\b|\.composer\s+button\b|\.workspace-search\s+button\b|\.workspace-more\b|\.workspace-avatar-options\s+button\b|\.workspace-menu-toggle\b|\.skill-menu-toggle\b|\.run-status-control\b|\.goal-icon-action\b)/i;
for (const rule of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = rule[1].trim();
  const isControl = compactControlSelector.test(selector) && !nonControlDescendant.test(selector) && !/\.skill-select-box\s*$/i.test(selector);
  const isSquareControl = squareControlSelector.test(selector) && !/(?:>\s*span|\.skill-revision-badge)\s*$/i.test(selector);
  if (!isControl && !isSquareControl) continue;
  for (const declaration of rule[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    const [, property, value] = declaration;
    const rawSize = value.trim().match(/^(\d+(?:\.\d+)?)px$/);
    if (isControl && /^(?:height|min-height)$/.test(property) && rawSize && Number(rawSize[1]) <= 44) {
      throw new Error(`${selector} ${property} must use the shared compact control scale: ${value.trim()}`);
    }
    if (isSquareControl && /^(?:width|min-width)$/.test(property) && rawSize && Number(rawSize[1]) <= 44) {
      throw new Error(`${selector} ${property} must use the same shared scale as its square-control height: ${value.trim()}`);
    }
  }
}
const cssClasses = new Set([...cssWithoutComments.matchAll(/\.(-?[_a-z]+[_a-z0-9-]*)/gi)].map((match) => match[1]));
const unusedClasses = [...cssClasses].filter((name) => {
  if (dynamicClasses.has(name)) return false;
  if (name.startsWith("hljs-")) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`(^|[^_a-z0-9-])${escaped}([^_a-z0-9-]|$)`, "i").test(componentSource);
});
if (unusedClasses.length) throw new Error(`Unused component selectors: ${unusedClasses.map((name) => `.${name}`).join(", ")}`);

const indexHtml = read("index.html", projectRoot);
const bootLight = block(indexHtml, ":root");
const bootDark = block(indexHtml, ':root[data-theme="dark"]');
const mirrors = [
  ["boot-surface", "surface"],
  ["boot-muted", "surface-muted"],
  ["boot-raised", "surface-raised"],
  ["boot-line", "border"],
  ["boot-ink", "foreground-strong"],
  ["boot-copy", "foreground-muted"],
];

for (const [bootName, designName] of mirrors) {
  for (const [theme, bootValues, designValues] of [
    ["light", tokens(bootLight.body), tokens(designLight.body)],
    ["dark", tokens(bootDark.body), tokens(designDark.body)],
  ]) {
    if (bootValues.get(bootName) === designValues.get(designName)) continue;
    throw new Error(`Boot ${theme} token --${bootName} must mirror --${designName}`);
  }
}

for (const [theme, bootValues, designValues, themeMirrors] of [
  ["light", tokens(bootLight.body), tokens(designLight.body), [["boot-mark-bg", "foreground-strong"], ["boot-mark-fg", "accent-contrast"]]],
  ["dark", tokens(bootDark.body), tokens(designDark.body), [["boot-mark-bg", "accent"], ["boot-mark-fg", "accent-contrast"]]],
]) {
  for (const [bootName, designName] of themeMirrors) {
    if (bootValues.get(bootName) === designValues.get(designName)) continue;
    throw new Error(`Boot ${theme} token --${bootName} must mirror --${designName}`);
  }
}

process.stdout.write("Web styles use the canonical four-file entrypoint and bidirectional cascade ownership without shadowed declarations: ordered layout base/refinement sublayers own mechanics, ordered design baseline/refinement sublayers own appearance, and features own explicit exceptions. Base/derived semantic color, readable type size/weight/tracking/leading, spacing, stroke, opacity, compact-control, row-density, indicator/icon geometry, shared React icon sizes, shared content/empty/reading measures, shared control motion/press/hover behavior, radius, depth, layer and motion scales have live selectors; layout appearance, design geometry, feature-level CSS imports, component-local color mixes and font stacks, compatibility token aliases, retired Workspace/Audit shell class names, redundant Audit availability chrome, broad semantic surface fills, glass effects, raw density heights, raw small squares, raw compact dimensions and position offsets, raw JSX icon sizes, raw transform offsets, raw compact grid tracks, raw progress heights, redundant component-local control transitions, CSS capitalization of data labels and non-accessibility !important overrides are rejected, starter prompts and dense evidence plus interface surfaces remain shared ledgers, optional Workspace-switcher rows stay anchored, custom Workspace icons remain monochrome, accessible navigation and source classes use canonical Workspace/Audit terminology, message action visibility plus compact Gate selection focus and redacted transcript hierarchy stay authoritative in design.refinement, readable neutral, accent, and semantic text tokens keep at least 4.5:1 contrast in both themes, operational status colors keep their info/success/warning/danger roles, neutral hierarchy cannot regain accent color, and boot colors mirror both themes.\n");

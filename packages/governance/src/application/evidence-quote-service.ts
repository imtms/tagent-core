import { createHash } from "node:crypto";
import type { EvidenceQuote, EvidenceQuoteSelector, EvidenceSource } from "../domain/governance.js";
import { stableJson } from "../domain/operation-digest.js";

/** Keep individual model-proposed excerpts bounded before they enter a Gate receipt. */
export const MAX_EVIDENCE_QUOTE_BYTES = 16 * 1_024;

export function evidenceSourceHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function createEvidenceSource(
  kind: EvidenceSource["kind"],
  sourceRef: string,
  sourceRevision: string,
  content: string,
): EvidenceSource {
  return { kind, sourceRef, sourceRevision, sourceHash: evidenceSourceHash(content), content };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Evidence quote ${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Evidence quote ${label} must be a non-negative integer`);
  return Number(value);
}

function parseSelector(value: unknown): EvidenceQuoteSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evidence quote selector must be an object");
  const selector = value as Record<string, unknown>;
  if (selector.kind === "text_quote") {
    if (typeof selector.exact !== "string" || !selector.exact
      || Buffer.byteLength(selector.exact, "utf8") > MAX_EVIDENCE_QUOTE_BYTES) {
      throw new Error(`Evidence text quote must contain 1..${MAX_EVIDENCE_QUOTE_BYTES} UTF-8 bytes`);
    }
    return { kind: "text_quote", exact: selector.exact, ...(selector.occurrence === undefined ? {} : { occurrence: positiveInteger(selector.occurrence, "occurrence") }) };
  }
  if (selector.kind === "line_range") return {
    kind: "line_range",
    startLine: positiveInteger(selector.startLine, "startLine"),
    endLine: positiveInteger(selector.endLine, "endLine"),
  };
  if (selector.kind === "byte_range") return {
    kind: "byte_range",
    startByte: nonNegativeInteger(selector.startByte, "startByte"),
    endByte: nonNegativeInteger(selector.endByte, "endByte"),
  };
  if (selector.kind === "json_pointer") {
    if (typeof selector.pointer !== "string" || selector.pointer.length > 2_000
      || selector.pointer && (!selector.pointer.startsWith("/") || /~(?:[^01]|$)/.test(selector.pointer))) {
      throw new Error("Evidence JSON Pointer is invalid");
    }
    return { kind: "json_pointer", pointer: selector.pointer };
  }
  throw new Error("Evidence quote selector kind is unknown");
}

function selectedQuote(source: EvidenceSource, selector: EvidenceQuoteSelector): string {
  if (selector.kind === "text_quote") {
    const occurrence = selector.occurrence ?? 1;
    let index = -1;
    for (let count = 0; count < occurrence; count += 1) {
      index = source.content.indexOf(selector.exact, index + 1);
      if (index < 0) throw new Error("Evidence text quote does not occur in the source");
    }
    return selector.exact;
  }
  if (selector.kind === "line_range") {
    const separators = [...source.content.matchAll(/\r\n|\n|\r/g)].map((match) => match[0]);
    const lines = source.content.split(/\r\n|\n|\r/);
    if (selector.endLine < selector.startLine || selector.endLine > lines.length) throw new Error("Evidence line range is outside the source");
    return lines.slice(selector.startLine - 1, selector.endLine).map((line, index) => {
      const lineIndex = selector.startLine - 1 + index;
      return lineIndex < selector.endLine - 1 ? line + separators[lineIndex] : line;
    }).join("");
  }
  if (selector.kind === "byte_range") {
    const bytes = Buffer.from(source.content, "utf8");
    if (selector.endByte <= selector.startByte || selector.endByte > bytes.length) throw new Error("Evidence byte range is outside the source");
    const quote = bytes.subarray(selector.startByte, selector.endByte).toString("utf8");
    if (!quote || !Buffer.from(quote, "utf8").equals(bytes.subarray(selector.startByte, selector.endByte))) {
      throw new Error("Evidence byte range must align to UTF-8 code-point boundaries");
    }
    return quote;
  }
  let current: unknown;
  try { current = JSON.parse(source.content); }
  catch { throw new Error("Evidence JSON Pointer source is not valid JSON"); }
  if (selector.pointer) for (const encoded of selector.pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) throw new Error("Evidence JSON Pointer does not resolve");
      current = current[Number(key)];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, key)) current = (current as Record<string, unknown>)[key];
    else throw new Error("Evidence JSON Pointer does not resolve");
  }
  return typeof current === "string" ? current : stableJson(current);
}

/** Validate a model-proposed quote and return only Core-derived immutable fields. */
export function verifyEvidenceQuote(value: unknown, sources: ReadonlyMap<string, EvidenceSource>): EvidenceQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evidence quote must be an object");
  const proposed = value as Record<string, unknown>;
  if (typeof proposed.sourceRef !== "string") throw new Error("Evidence quote sourceRef is invalid");
  const source = sources.get(proposed.sourceRef);
  if (!source) throw new Error(`Evidence quote source is unavailable: ${proposed.sourceRef}`);
  if (proposed.sourceRevision !== source.sourceRevision || proposed.sourceHash !== source.sourceHash) {
    throw new Error(`Evidence quote source revision or hash does not match: ${proposed.sourceRef}`);
  }
  const selector = parseSelector(proposed.selector);
  const quote = selectedQuote(source, selector);
  if (Buffer.byteLength(quote, "utf8") > MAX_EVIDENCE_QUOTE_BYTES) {
    throw new Error(`Evidence quote exceeds the ${MAX_EVIDENCE_QUOTE_BYTES}-byte limit`);
  }
  if (typeof proposed.quote !== "string" || proposed.quote !== quote) throw new Error("Evidence quote bytes do not match the selected source content");
  return { sourceRef: source.sourceRef, sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, selector, quote };
}

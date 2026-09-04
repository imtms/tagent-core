import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_QUOTE_BYTES,
  createEvidenceSource,
  verifyEvidenceQuote,
} from "@tagent/governance/application";

describe("Core-verified Evidence Quotes", () => {
  const source = createEvidenceSource(
    "artifact",
    "artifact:report",
    "created:42",
    "alpha\nbeta beta\n{\"nested\":{\"z\":1,\"a\":2}}",
  );
  const sources = new Map([[source.sourceRef, source]]);
  const quote = (selector: unknown, selected: string) => verifyEvidenceQuote({
    sourceRef: source.sourceRef,
    sourceRevision: source.sourceRevision,
    sourceHash: source.sourceHash,
    selector,
    quote: selected,
  }, sources);

  it("verifies exact text, inclusive lines, half-open UTF-8 bytes, and JSON Pointers", () => {
    expect(quote({ kind: "text_quote", exact: "beta", occurrence: 2 }, "beta").quote).toBe("beta");
    expect(quote({ kind: "line_range", startLine: 1, endLine: 2 }, "alpha\nbeta beta").quote)
      .toBe("alpha\nbeta beta");
    expect(quote({ kind: "byte_range", startByte: 6, endByte: 10 }, "beta").quote).toBe("beta");

    const json = createEvidenceSource("operation", "operation:json", "completed:7", "{\"nested\":{\"z\":1,\"a\":2}}");
    expect(verifyEvidenceQuote({
      sourceRef: json.sourceRef,
      sourceRevision: json.sourceRevision,
      sourceHash: json.sourceHash,
      selector: { kind: "json_pointer", pointer: "/nested" },
      quote: "{\"a\":2,\"z\":1}",
    }, new Map([[json.sourceRef, json]])).quote).toBe("{\"a\":2,\"z\":1}");
  });

  it("preserves source line endings and implements RFC 6901 escaping exactly", () => {
    const lines = createEvidenceSource("artifact", "artifact:crlf", "created:1", "alpha\r\nbeta\rthird");
    expect(verifyEvidenceQuote({
      sourceRef: lines.sourceRef, sourceRevision: lines.sourceRevision, sourceHash: lines.sourceHash,
      selector: { kind: "line_range", startLine: 1, endLine: 3 }, quote: "alpha\r\nbeta\rthird",
    }, new Map([[lines.sourceRef, lines]])).quote).toBe("alpha\r\nbeta\rthird");

    const json = createEvidenceSource("operation", "operation:escaped-json", "completed:1", JSON.stringify({ "": "root-member", "a/b": { "m~n": 7 } }));
    const jsonSources = new Map([[json.sourceRef, json]]);
    const verifyPointer = (pointer: string, selected: string) => verifyEvidenceQuote({
      sourceRef: json.sourceRef, sourceRevision: json.sourceRevision, sourceHash: json.sourceHash,
      selector: { kind: "json_pointer", pointer }, quote: selected,
    }, jsonSources);
    expect(verifyPointer("", "{\"\":\"root-member\",\"a/b\":{\"m~n\":7}}" as string).quote)
      .toBe("{\"\":\"root-member\",\"a/b\":{\"m~n\":7}}");
    expect(verifyPointer("/a~1b/m~0n", "7").quote).toBe("7");
    expect(verifyPointer("/", "root-member").quote).toBe("root-member");
    expect(() => verifyPointer("/a~2b", "unused")).toThrow("JSON Pointer is invalid");
    expect(() => verifyPointer("/a~", "unused")).toThrow("JSON Pointer is invalid");
  });

  it("rejects unavailable, stale, tampered, out-of-range, and split UTF-8 quotes", () => {
    expect(() => verifyEvidenceQuote({
      sourceRef: "artifact:missing", sourceRevision: source.sourceRevision, sourceHash: source.sourceHash,
      selector: { kind: "text_quote", exact: "alpha" }, quote: "alpha",
    }, sources)).toThrow("source is unavailable");
    expect(() => verifyEvidenceQuote({
      sourceRef: source.sourceRef, sourceRevision: "created:old", sourceHash: source.sourceHash,
      selector: { kind: "text_quote", exact: "alpha" }, quote: "alpha",
    }, sources)).toThrow("revision or hash does not match");
    expect(() => quote({ kind: "text_quote", exact: "alpha" }, "changed")).toThrow("bytes do not match");
    expect(() => quote({ kind: "line_range", startLine: 2, endLine: 9 }, "beta beta"))
      .toThrow("line range is outside");

    const unicode = createEvidenceSource("transcript", "transcript:run:1", "seq:1", "A中B");
    expect(() => verifyEvidenceQuote({
      sourceRef: unicode.sourceRef,
      sourceRevision: unicode.sourceRevision,
      sourceHash: unicode.sourceHash,
      selector: { kind: "byte_range", startByte: 1, endByte: 2 },
      quote: "�",
    }, new Map([[unicode.sourceRef, unicode]]))).toThrow("UTF-8 code-point boundaries");
  });

  it("applies one UTF-8 byte cap to text, line, byte, and JSON Pointer selectors", () => {
    const oversized = "中".repeat(Math.floor(MAX_EVIDENCE_QUOTE_BYTES / 3) + 1);
    const lineSource = createEvidenceSource("artifact", "artifact:large-line", "created:1", oversized);
    const byteSource = createEvidenceSource("artifact", "artifact:large-bytes", "created:1", oversized);
    const jsonSource = createEvidenceSource("artifact", "artifact:large-json", "created:1", JSON.stringify({ value: oversized }));
    const proposed = (sourceRef: string, sourceRevision: string, sourceHash: string, selector: unknown, selected: string) => ({
      sourceRef, sourceRevision, sourceHash, selector, quote: selected,
    });

    expect(() => verifyEvidenceQuote(proposed(lineSource.sourceRef, lineSource.sourceRevision, lineSource.sourceHash,
      { kind: "line_range", startLine: 1, endLine: 1 }, oversized), new Map([[lineSource.sourceRef, lineSource]])))
      .toThrow("exceeds");
    expect(() => verifyEvidenceQuote(proposed(byteSource.sourceRef, byteSource.sourceRevision, byteSource.sourceHash,
      { kind: "byte_range", startByte: 0, endByte: Buffer.byteLength(oversized) }, oversized), new Map([[byteSource.sourceRef, byteSource]])))
      .toThrow("exceeds");
    expect(() => verifyEvidenceQuote(proposed(jsonSource.sourceRef, jsonSource.sourceRevision, jsonSource.sourceHash,
      { kind: "json_pointer", pointer: "/value" }, oversized), new Map([[jsonSource.sourceRef, jsonSource]])))
      .toThrow("exceeds");
    expect(() => verifyEvidenceQuote(proposed(lineSource.sourceRef, lineSource.sourceRevision, lineSource.sourceHash,
      { kind: "text_quote", exact: oversized }, oversized), new Map([[lineSource.sourceRef, lineSource]])))
      .toThrow("UTF-8 bytes");
  });
});

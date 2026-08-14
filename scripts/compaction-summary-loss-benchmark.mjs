/* global console */
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const corpusUrl = new URL("../benchmarks/compaction-summary-loss.json", import.meta.url);
const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));
const snippetChars = 320;
const maxMatchesPerFact = 3;

function ratio(found, total) {
  return total === 0 ? 1 : Number((found / total).toFixed(3));
}

function boundedSnippet(source, literal) {
  const index = source.indexOf(literal);
  if (index < 0) return undefined;
  const available = Math.max(0, snippetChars - literal.length);
  const before = Math.floor(available / 2);
  let start = Math.max(0, index - before);
  let end = Math.min(source.length, start + snippetChars);
  start = Math.max(0, end - snippetChars);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

function searchTranscript(transcript, literal) {
  const matches = [];
  for (let index = transcript.length - 1; index >= 0 && matches.length < maxMatchesPerFact; index -= 1) {
    const serialized = JSON.stringify(transcript[index]);
    const snippet = boundedSnippet(serialized, literal);
    if (snippet !== undefined) matches.push({ seq: index + 1, role: transcript[index].role, snippet });
  }
  return matches;
}

function expandTranscript(transcript) {
  return JSON.parse(JSON.stringify(transcript).replaceAll("[BENCHMARK_PADDING_8000]", "diagnostic-padding-".repeat(500)));
}

const classTotals = new Map();
const cases = [];
let totalFacts = 0;
let summaryFacts = 0;
let searchFacts = 0;
let fullTranscriptChars = 0;
let boundedSearchChars = 0;

for (const fixture of corpus.cases) {
  const transcript = expandTranscript(fixture.transcript);
  const transcriptJson = JSON.stringify(transcript);
  const facts = fixture.facts.map((fact) => {
    const summaryHit = fixture.summary.includes(fact.literal);
    const matches = searchTranscript(transcript, fact.literal);
    const searchHit = matches.length > 0;
    const aggregate = classTotals.get(fact.class) ?? { facts: 0, summaryHits: 0, searchHits: 0 };
    aggregate.facts += 1;
    if (summaryHit) aggregate.summaryHits += 1;
    if (searchHit) aggregate.searchHits += 1;
    classTotals.set(fact.class, aggregate);
    totalFacts += 1;
    if (summaryHit) summaryFacts += 1;
    if (searchHit) searchFacts += 1;
    boundedSearchChars += Buffer.byteLength(JSON.stringify(matches));
    return { class: fact.class, literal: fact.literal, summaryHit, searchHit };
  });
  fullTranscriptChars += Buffer.byteLength(transcriptJson);
  cases.push({
    id: fixture.id,
    facts: facts.length,
    summaryRecall: ratio(facts.filter((fact) => fact.summaryHit).length, facts.length),
    literalSearchRecall: ratio(facts.filter((fact) => fact.searchHit).length, facts.length),
    transcriptChars: Buffer.byteLength(transcriptJson),
    resultChars: facts.reduce((sum, fact) => sum + Buffer.byteLength(JSON.stringify(searchTranscript(transcript, fact.literal))), 0),
    factResults: facts,
  });
}

const summaryRecall = ratio(summaryFacts, totalFacts);
const literalSearchRecall = ratio(searchFacts, totalFacts);
const boundedCostRatio = Number((boundedSearchChars / Math.max(1, fullTranscriptChars)).toFixed(3));
const decision = summaryRecall < 0.8 && literalSearchRecall >= 0.95 && boundedCostRatio < 0.75
  ? "add_history_search_only"
  : "do_not_add_history_tools";

console.log(JSON.stringify({
  benchmark: "compaction-summary-loss",
  schemaVersion: corpus.schemaVersion,
  deterministic: true,
  configuration: { snippetChars, maxMatchesPerFact, decisionThresholds: { summaryRecallBelow: 0.8, literalSearchRecallAtLeast: 0.95, boundedCostRatioBelow: 0.75 } },
  aggregate: {
    facts: totalFacts,
    summaryExactFactRecall: summaryRecall,
    durableLiteralSearchRecall: literalSearchRecall,
    fullTranscriptChars,
    boundedSearchResultChars: boundedSearchChars,
    boundedSearchToTranscriptCostRatio: boundedCostRatio,
  },
  byFactClass: Object.fromEntries([...classTotals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([factClass, value]) => [factClass, {
    ...value,
    summaryRecall: ratio(value.summaryHits, value.facts),
    literalSearchRecall: ratio(value.searchHits, value.facts),
  }])),
  cases,
  decision,
  limitations: [
    "The fixed summaries are representative fixtures, not a statistical estimate of any provider model.",
    "Exact-literal recall measures suspected known facts; it does not solve unknown-unknown discovery or semantic paraphrases.",
    "Character counts approximate model-visible cost and exclude the static tool schema and call arguments.",
    "The corpus is intentionally small and should grow from production-safe regression cases when available."
  ]
}, null, 2));

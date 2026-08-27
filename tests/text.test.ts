import { describe, expect, it } from "vitest";
import { contentTerms, tokenizeWords, weightedCoverage } from "@/lib/text";
import { toMatchExpression } from "@/lib/store/repository";
import { hashEmbed } from "@/lib/providers/offline";

describe("tokenizeWords", () => {
  it("drops function words and spoken fillers", () => {
    expect(tokenizeWords("Yeah, okay, so I think we should actually use Postgres")).toEqual(["use", "postgres"]);
  });

  it("keeps identifiers and numbers", () => {
    expect(tokenizeWords("incident MI-412 hit p99 latency")).toContain("mi-412");
    expect(tokenizeWords("incident MI-412 hit p99 latency")).toContain("p99");
  });
});

describe("contentTerms", () => {
  it("deduplicates and preserves order", () => {
    expect(contentTerms("Postgres versus Postgres versus DynamoDB")).toEqual(["postgres", "versus", "dynamodb"]);
  });

  it("caps the number of terms", () => {
    expect(contentTerms(Array.from({ length: 60 }, (_, i) => `term${i}`).join(" "), 10)).toHaveLength(10);
  });
});

describe("toMatchExpression", () => {
  it("quotes every term so punctuation cannot become an FTS operator", () => {
    expect(toMatchExpression("Q3 roadmap (post-launch)?")).toBe('"roadmap" OR "post-launch"');
  });

  it("returns null when a question is nothing but function words", () => {
    expect(toMatchExpression("what about it?")).toBeNull();
    expect(toMatchExpression("???")).toBeNull();
  });
});

describe("weightedCoverage", () => {
  const corpusSize = 100;

  it("is high when the specific terms of a query are present", () => {
    const terms = ["pgvector", "replica"];
    const frequencies = new Map([
      ["pgvector", 3],
      ["replica", 5],
    ]);
    expect(weightedCoverage(terms, "we moved pgvector onto the analytics replica", frequencies, corpusSize)).toBe(1);
  });

  it("is low when the query's terms appear nowhere in the corpus", () => {
    const terms = ["parental", "childcare"];
    const frequencies = new Map([
      ["parental", 0],
      ["childcare", 0],
    ]);
    expect(weightedCoverage(terms, "unrelated meeting text", frequencies, corpusSize)).toBe(0);
  });

  it("weights a rare matched term above a common one", () => {
    const frequencies = new Map([
      ["pgvector", 1],
      ["meeting", 90],
    ]);
    const rareMatched = weightedCoverage(["pgvector", "meeting"], "pgvector was enabled", frequencies, corpusSize);
    const commonMatched = weightedCoverage(["pgvector", "meeting"], "this meeting was long", frequencies, corpusSize);
    expect(rareMatched).toBeGreaterThan(commonMatched);
  });

  it("treats a query with no content terms as covered, so it is not refused on that basis", () => {
    expect(weightedCoverage([], "anything", new Map(), corpusSize)).toBe(1);
  });
});

describe("hashEmbed", () => {
  it("is deterministic", () => {
    expect(hashEmbed("we decided to use Postgres")).toEqual(hashEmbed("we decided to use Postgres"));
  });

  it("returns unit vectors so the dot product is a cosine", () => {
    const vector = hashEmbed("we decided to use Postgres for analytics");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("scores related text above unrelated text", () => {
    const query = hashEmbed("which database did we choose for analytics");
    const related = hashEmbed("we chose Postgres aggregate tables for the analytics database");
    const unrelated = hashEmbed("the tooltip copy is blocked on design sign-off");
    const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  });

  it("survives empty input", () => {
    expect(hashEmbed("").every((value) => value === 0)).toBe(true);
  });
});

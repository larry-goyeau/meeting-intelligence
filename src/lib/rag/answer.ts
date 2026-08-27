import { config } from "@/lib/config";
import { createLogger, timed, type Logger } from "@/lib/logger";
import { getProviders } from "@/lib/providers";
import { estimateCostUsd, estimateTokens } from "@/lib/providers/tokens";
import { Repository } from "@/lib/store/repository";
import type { ChatTurn, RetrievalRoute, Source, StageTiming, Trace, Usage } from "@/lib/types";
import {
  checkQuestion,
  evaluateAnswer,
  noEvidenceAnswer,
  stripInvalidCitations,
} from "./guardrails";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerPrompt,
  buildRewritePrompt,
  buildWholeMeetingPrompt,
  REWRITE_SYSTEM_PROMPT,
} from "./prompts";
import { retrieve } from "./retrieve";

/**
 * The query pipeline, from a user message to a cited answer.
 *
 * The one structural decision worth calling out is routing. Retrieval is the
 * wrong tool for "summarise this meeting" or "what did we decide overall": the
 * answer is spread across the whole transcript, and any top-k selection will
 * silently omit most of it. So a small meeting, or a question that is clearly
 * about a meeting as a whole, is answered from the full transcript instead. It is
 * the same reasoning that says not to use RAG at all when the corpus fits in the
 * window — applied per question rather than once for the whole product.
 */

export interface AskRequest {
  question: string;
  history: ChatTurn[];
  meetingIds: string[];
}

export interface AskEvent {
  type: "meta" | "delta" | "done" | "error";
  data: unknown;
}

/** Questions about a meeting as a whole, where top-k retrieval loses by construction. */
const WHOLE_MEETING_PATTERNS = [
  /\b(summar(y|ise|ize)|recap|overview|tl;?dr)\b/i,
  /\b(all|every|each|full list of|complete list of)\s+(the\s+)?(decision|action|task|item|topic|question)/i,
  /\bwhat (was|were|did we) (discussed|covered|talked about|go over)\b/i,
  /\bminutes\b/i,
  /\bwalk me through\b/i,
];

export function looksLikeWholeMeetingQuestion(question: string): boolean {
  return WHOLE_MEETING_PATTERNS.some((pattern) => pattern.test(question));
}

interface Plan {
  route: RetrievalRoute;
  standaloneQuestion: string;
  sources: Source[];
  systemPrompt: string;
  userPrompt: string;
  refusal?: string;
  embeddingTokens: number;
  detail: Record<string, unknown>;
}

/**
 * Everything before token generation: rewrite, route, retrieve, build the prompt.
 * Separated from streaming so the evaluation harness can assert on retrieval
 * without generating (and paying for) an answer.
 */
export async function plan(
  request: AskRequest,
  repository: Repository,
  stages: StageTiming[],
  logger: Logger,
): Promise<Plan> {
  const providers = getProviders();
  const inputCheck = checkQuestion(request.question);
  if (!inputCheck.ok) {
    return {
      route: "refused",
      standaloneQuestion: request.question,
      sources: [],
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt: "",
      refusal: inputCheck.reason,
      embeddingTokens: 0,
      detail: { flags: inputCheck.flags },
    };
  }

  // Rewriting is only worth a round-trip when there is history to resolve against.
  const standaloneQuestion =
    request.history.length === 0
      ? request.question.trim()
      : await timed(stages, "rewrite", async () => {
          const result = await providers.chat.complete({
            task: "rewrite",
            temperature: 0,
            maxOutputTokens: 120,
            messages: [
              { role: "system", content: REWRITE_SYSTEM_PROMPT },
              { role: "user", content: buildRewritePrompt(request.question, request.history) },
            ],
          });
          const rewritten = result.text.trim();
          // A model that returns nothing useful must not blank out the query.
          return rewritten.length > 2 ? rewritten : request.question.trim();
        }, (value) => ({ rewritten: value }));

  const scoped = request.meetingIds.length > 0 ? request.meetingIds : undefined;
  const wholeMeeting = decideWholeMeeting(request.question, scoped, repository);

  if (wholeMeeting) {
    const transcripts = wholeMeeting.map((meeting) => ({
      title: meeting.title,
      date: meeting.date,
      transcript: meeting.transcript,
    }));
    logger.info("route.whole_meeting", { meetings: wholeMeeting.length });
    return {
      route: "whole-meeting",
      standaloneQuestion,
      // Whole transcripts are still exposed as sources so the UI, the citation
      // check and the trace inspector all keep working unchanged.
      sources: wholeMeeting.map((meeting, index) => ({
        id: `${meeting.id}:full`,
        meetingId: meeting.id,
        ordinal: 0,
        text: meeting.transcript,
        header: "",
        speakers: meeting.participants,
        startMs: 0,
        endMs: meeting.durationMs,
        firstTurnIndex: 0,
        lastTurnIndex: Math.max(0, meeting.turnCount - 1),
        tokenCount: meeting.tokenCount,
        denseRank: null,
        lexicalRank: null,
        fusedScore: 1,
        meetingTitle: meeting.title,
        meetingDate: meeting.date,
        label: `S${index + 1}`,
        viaNeighbour: false,
      })),
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt: buildWholeMeetingPrompt(standaloneQuestion, transcripts, request.history),
      embeddingTokens: 0,
      detail: { reason: "whole-transcript fits the budget and the question is about the meeting overall" },
    };
  }

  const retrieval = await timed(
    stages,
    "retrieve",
    () => retrieve(repository, standaloneQuestion, { meetingIds: scoped }),
    (result) => ({
      dense: result.denseCount,
      lexical: result.lexicalCount,
      candidates: result.candidates.length,
      selected: result.sources.length,
      droppedForBudget: result.droppedForBudget,
      maxDenseScore: result.relevance.maxDenseScore,
      queryCoverage: result.relevance.queryCoverage,
    }),
  );

  if (retrieval.sources.length === 0) {
    return {
      route: "refused",
      standaloneQuestion,
      sources: [],
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt: "",
      refusal: noEvidenceAnswer(request.question, repository.countChunks() === 0),
      embeddingTokens: retrieval.embeddingTokens,
      detail: { candidates: retrieval.candidates.length, relevance: retrieval.relevance },
    };
  }

  return {
    route: "retrieval",
    standaloneQuestion,
    sources: retrieval.sources,
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    userPrompt: buildAnswerPrompt(standaloneQuestion, retrieval.sources, request.history),
    embeddingTokens: retrieval.embeddingTokens,
    detail: {
      contextTokens: retrieval.sources.reduce((sum, source) => sum + source.tokenCount, 0),
      neighbours: retrieval.sources.filter((source) => source.viaNeighbour).length,
    },
  };
}

/**
 * Whole-transcript answering applies when the selected meetings fit the ceiling
 * and either there is exactly one of them and it is small, or the question is
 * explicitly about the meeting as a whole.
 */
function decideWholeMeeting(question: string, meetingIds: string[] | undefined, repository: Repository) {
  if (!meetingIds || meetingIds.length === 0 || meetingIds.length > 3) return null;
  const meetings = meetingIds
    .map((id) => {
      const meeting = repository.getMeeting(id);
      const transcript = repository.getTranscript(id);
      return meeting && transcript ? { ...meeting, transcript } : null;
    })
    .filter((meeting): meeting is NonNullable<typeof meeting> => meeting !== null);
  if (meetings.length === 0) return null;

  const totalTokens = meetings.reduce((sum, meeting) => sum + meeting.tokenCount, 0);
  if (totalTokens > config.guardrails.wholeMeetingTokenCeiling) return null;

  const isOverviewQuestion = looksLikeWholeMeetingQuestion(question);
  const fitsComfortably = totalTokens <= config.retrieval.contextTokenBudget;
  return isOverviewQuestion || fitsComfortably ? meetings : null;
}

/**
 * Runs the pipeline and yields events for the HTTP layer to serialise. The `meta`
 * event goes out before generation starts so the UI can render source cards while
 * the answer is still streaming.
 */
export async function* ask(request: AskRequest, repository = new Repository()): AsyncGenerator<AskEvent> {
  const traceId = crypto.randomUUID();
  const logger = createLogger(traceId, { question: request.question.slice(0, 120) });
  const providers = getProviders();
  const stages: StageTiming[] = [];
  const startedAt = performance.now();

  logger.info("ask.start", { historyTurns: request.history.length, scope: request.meetingIds.length });

  try {
    const planned = await plan(request, repository, stages, logger);

    yield {
      type: "meta",
      data: {
        traceId,
        route: planned.route,
        standaloneQuestion: planned.standaloneQuestion,
        provider: providers.id,
        remote: providers.remote,
        sources: planned.sources.map(toClientSource),
      },
    };

    if (planned.refusal) {
      const usage = buildUsage(0, 0, planned.embeddingTokens, providers.chat.model, providers.embeddings.model);
      const verdict = evaluateAnswer(planned.refusal, []);
      yield { type: "delta", data: planned.refusal };
      const trace = assembleTrace({
        traceId,
        request,
        planned,
        answer: planned.refusal,
        verdict,
        usage,
        stages,
        totalMs: Math.round(performance.now() - startedAt),
      });
      repository.saveTrace(trace);
      logger.info("ask.refused", { reason: planned.detail });
      yield { type: "done", data: { verdict, usage, stages, totalMs: trace.totalMs, traceId } };
      return;
    }

    const generationStarted = performance.now();
    let answer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenMs: number | null = null;

    for await (const event of providers.chat.stream({
      task: "answer",
      temperature: 0.2,
      messages: [
        { role: "system", content: planned.systemPrompt },
        { role: "user", content: planned.userPrompt },
      ],
    })) {
      if (event.type === "delta") {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - generationStarted);
        answer += event.text;
        yield { type: "delta", data: event.text };
      } else {
        promptTokens = event.promptTokens;
        completionTokens = event.completionTokens;
      }
    }

    stages.push({
      stage: "generate",
      ms: Math.round(performance.now() - generationStarted),
      detail: { firstTokenMs, promptTokens, completionTokens },
    });

    // Post-generation checks run on the accumulated text. The stream is not held
    // back for them: the user sees tokens immediately, and the verdict arrives
    // with `done` to be rendered as a banner if something is off.
    const cleaned = stripInvalidCitations(answer, planned.sources);
    const verdict = evaluateAnswer(cleaned, planned.sources);
    const usage = buildUsage(
      promptTokens || estimateTokens(planned.userPrompt),
      completionTokens || estimateTokens(answer),
      planned.embeddingTokens,
      providers.chat.model,
      providers.embeddings.model,
    );

    const trace = assembleTrace({
      traceId,
      request,
      planned,
      answer: cleaned,
      verdict,
      usage,
      stages,
      totalMs: Math.round(performance.now() - startedAt),
    });
    repository.saveTrace(trace);

    logger.info("ask.done", {
      route: planned.route,
      sources: planned.sources.length,
      coverage: verdict.citationCoverage,
      flags: verdict.flags,
      totalMs: trace.totalMs,
      costUsd: usage.estimatedCostUsd,
    });

    yield {
      type: "done",
      data: {
        verdict,
        usage,
        stages,
        totalMs: trace.totalMs,
        traceId,
        // The client replaces its accumulated text with this, so stripped
        // citations do not linger on screen.
        answer: cleaned !== answer ? cleaned : undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("ask.failed", { message });
    yield { type: "error", data: { message } };
  }
}

/**
 * On the whole-transcript route a "source" is an entire meeting. Sending that to
 * the browser and storing it in every trace would bloat both for no benefit, so
 * source text is capped; the transcript viewer already has the full thing.
 */
const MAX_SOURCE_TEXT_CHARS = 4000;

function capText(text: string): string {
  return text.length <= MAX_SOURCE_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_SOURCE_TEXT_CHARS)}\n\u2026 [truncated for display \u2014 open the transcript to read the rest]`;
}

/** Source shape sent to the browser: full text for the panel, no embedding header. */
function toClientSource(source: Source) {
  return {
    id: source.id,
    label: source.label,
    meetingId: source.meetingId,
    meetingTitle: source.meetingTitle,
    meetingDate: source.meetingDate,
    speakers: source.speakers,
    startMs: source.startMs,
    endMs: source.endMs,
    firstTurnIndex: source.firstTurnIndex,
    lastTurnIndex: source.lastTurnIndex,
    text: capText(source.text),
    fusedScore: Number(source.fusedScore.toFixed(5)),
    denseRank: source.denseRank,
    lexicalRank: source.lexicalRank,
    viaNeighbour: source.viaNeighbour,
    tokenCount: source.tokenCount,
  };
}

function buildUsage(
  promptTokens: number,
  completionTokens: number,
  embeddingTokens: number,
  chatModel: string,
  embeddingModel: string,
): Usage {
  return {
    promptTokens,
    completionTokens,
    embeddingTokens,
    estimatedCostUsd:
      estimateCostUsd(chatModel, promptTokens, completionTokens) + estimateCostUsd(embeddingModel, embeddingTokens, 0),
  };
}

function assembleTrace(input: {
  traceId: string;
  request: AskRequest;
  planned: Plan;
  answer: string;
  verdict: Trace["verdict"];
  usage: Usage;
  stages: StageTiming[];
  totalMs: number;
}): Trace {
  const providers = getProviders();
  return {
    id: input.traceId,
    createdAt: new Date().toISOString(),
    question: input.request.question,
    standaloneQuestion: input.planned.standaloneQuestion,
    meetingScope: input.request.meetingIds,
    route: input.planned.route,
    sources: input.planned.sources.map((source) => ({ ...source, text: capText(source.text) })),
    stages: input.stages,
    usage: input.usage,
    totalMs: input.totalMs,
    answer: input.answer,
    verdict: input.verdict,
    provider: providers.id,
    models: { chat: providers.chat.model, embedding: providers.embeddings.model },
  };
}

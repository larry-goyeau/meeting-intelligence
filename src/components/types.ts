import type { GuardrailVerdict, Meeting, MeetingWithTurns, RetrievalRoute, StageTiming, Usage } from "@/lib/types";

/** Shapes exchanged with the API. Kept apart from the domain types so the wire format is explicit. */

export interface ClientSource {
  id: string;
  label: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  speakers: string[];
  startMs: number | null;
  endMs: number | null;
  firstTurnIndex: number;
  lastTurnIndex: number;
  text: string;
  fusedScore: number;
  denseRank: number | null;
  lexicalRank: number | null;
  viaNeighbour: boolean;
  tokenCount: number;
}

export interface ChatMeta {
  traceId: string;
  route: RetrievalRoute;
  standaloneQuestion: string;
  provider: string;
  remote: boolean;
  sources: ClientSource[];
}

export interface ChatDone {
  verdict: GuardrailVerdict;
  usage: Usage;
  stages: StageTiming[];
  totalMs: number;
  traceId: string;
  answer?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  meta?: ChatMeta;
  done?: ChatDone;
  error?: string;
}

export interface HealthResponse {
  status: string;
  provider: {
    id: string;
    remote: boolean;
    chatModel: string;
    embeddingModel: string;
    embeddingDimensions: number;
    transcriptionAvailable: boolean;
    baseUrl: string | null;
  };
  corpus: { meetings: number; chunks: number; turns: number; tokens: number };
  retrieval: Record<string, number>;
  chunking: Record<string, number>;
}

export type { Meeting, MeetingWithTurns };

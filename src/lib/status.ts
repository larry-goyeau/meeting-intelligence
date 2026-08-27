import { config } from "./config";
import { providerSummary } from "./providers";
import { Repository } from "./store/repository";
import type { Meeting } from "./types";

/**
 * The system's self-description: active provider, corpus size, retrieval settings.
 *
 * Shared by the health endpoint and by the server-rendered first paint, so the UI
 * arrives with data already in it instead of flashing an empty shell and then
 * fetching. One source of truth for both, so they cannot drift.
 */

export interface SystemStatus {
  status: string;
  provider: ReturnType<typeof providerSummary>;
  corpus: { meetings: number; chunks: number; turns: number; tokens: number };
  retrieval: typeof config.retrieval;
  chunking: typeof config.chunking;
}

export function getSystemStatus(repository = new Repository()): { status: SystemStatus; meetings: Meeting[] } {
  const meetings = repository.listMeetings();
  return {
    status: {
      status: "ok",
      provider: providerSummary(),
      corpus: {
        meetings: meetings.length,
        chunks: repository.countChunks(),
        turns: meetings.reduce((sum, meeting) => sum + meeting.turnCount, 0),
        tokens: meetings.reduce((sum, meeting) => sum + meeting.tokenCount, 0),
      },
      retrieval: config.retrieval,
      chunking: config.chunking,
    },
    meetings,
  };
}

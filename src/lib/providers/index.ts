import { config, hasRemoteProvider } from "@/lib/config";
import { offlineChat, offlineEmbeddings, offlineTranscription } from "./offline";
import { openaiChat, openaiEmbeddings, openaiTranscription } from "./openai";
import type { ProviderBundle } from "./types";

/**
 * Provider selection happens exactly once, here, based on whether a key is
 * present. No feature flag, no runtime switch: mixing embedding providers within
 * one index would silently corrupt retrieval, so the choice is process-wide.
 */
let bundle: ProviderBundle | null = null;

export function getProviders(): ProviderBundle {
  if (bundle) return bundle;
  bundle = hasRemoteProvider
    ? { id: "openai", chat: openaiChat, embeddings: openaiEmbeddings, transcription: openaiTranscription, remote: true }
    : { id: "offline", chat: offlineChat, embeddings: offlineEmbeddings, transcription: offlineTranscription, remote: false };
  return bundle;
}

/** Test seam: lets a test pin a provider without touching the environment. */
export function setProviders(next: ProviderBundle | null): void {
  bundle = next;
}

export function providerSummary() {
  const providers = getProviders();
  return {
    id: providers.id,
    remote: providers.remote,
    chatModel: providers.chat.model,
    embeddingModel: providers.embeddings.model,
    embeddingDimensions: providers.embeddings.dimensions,
    transcriptionAvailable: providers.transcription.available,
    baseUrl: config.provider.baseUrl ?? null,
  };
}

export { offlineChat, offlineEmbeddings, offlineTranscription };
export type { ProviderBundle };

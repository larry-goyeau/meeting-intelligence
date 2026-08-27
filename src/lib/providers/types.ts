/**
 * The only vendor boundary in the app. Everything above this file talks to these
 * three interfaces, which is what makes the offline provider possible and what
 * would make swapping in Bedrock or a self-hosted model a one-file change.
 */

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatTask = "answer" | "rewrite" | "brief-map" | "brief-reduce";

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Requests a JSON object back. Used for the structured meeting brief. */
  json?: boolean;
  /**
   * Which pipeline step this call belongs to. Used as log metadata, and by the
   * offline provider to pick the right heuristic to stand in for the model.
   */
  task: ChatTask;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; promptTokens: number; completionTokens: number };

export interface ChatProvider {
  readonly id: string;
  readonly model: string;
  complete(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent>;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly model: string;
  readonly available: boolean;
  transcribe(file: File, options?: { language?: string }): Promise<string>;
}

export interface ProviderBundle {
  id: string;
  chat: ChatProvider;
  embeddings: EmbeddingProvider;
  transcription: TranscriptionProvider;
  /** True when answers come from a real LLM. Surfaced in the UI so demo output is never mistaken for production quality. */
  remote: boolean;
}

import OpenAI from "openai";
import { config } from "@/lib/config";
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  EmbeddingProvider,
  EmbeddingResult,
  TranscriptionProvider,
} from "./types";
import { estimateTokens } from "./tokens";

/**
 * OpenAI-compatible provider. Talks to the Chat Completions surface on purpose:
 * it is the API that every gateway, proxy and self-hosted server implements, so
 * `OPENAI_BASE_URL` is enough to point this at Azure, OpenRouter, vLLM or Ollama
 * without touching code.
 */

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.provider.apiKey,
      baseURL: config.provider.baseUrl,
      timeout: config.provider.requestTimeoutMs,
      maxRetries: 2,
    });
  }
  return client;
}

/** Embedding dimensions per model, needed up front to size the stored vectors. */
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/** The API rejects oversized batches; 96 keeps requests small enough to retry cheaply. */
const EMBED_BATCH_SIZE = 96;

export const openaiEmbeddings: EmbeddingProvider = {
  id: "openai",
  model: config.provider.embeddingModel,
  dimensions: EMBEDDING_DIMENSIONS[config.provider.embeddingModel] ?? 1536,
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const response = await getClient().embeddings.create({
        model: config.provider.embeddingModel,
        input: batch,
      });
      // The API does not promise ordering, so sort by index before collecting.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((item) => item.embedding));
      tokens += response.usage?.prompt_tokens ?? batch.reduce((sum, text) => sum + estimateTokens(text), 0);
    }
    return { vectors, tokens };
  },
};

export const openaiChat: ChatProvider = {
  id: "openai",
  model: config.provider.chatModel,
  async complete(request: ChatRequest): Promise<ChatResult> {
    const response = await getClient().chat.completions.create({
      model: config.provider.chatModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxOutputTokens ?? config.provider.maxOutputTokens,
      ...(request.json ? { response_format: { type: "json_object" as const } } : {}),
    });
    return {
      text: response.choices[0]?.message?.content ?? "",
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    };
  },
  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const stream = await getClient().chat.completions.create({
      model: config.provider.chatModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxOutputTokens ?? config.provider.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let emitted = 0;
    for await (const event of stream) {
      const delta = event.choices[0]?.delta?.content;
      if (delta) {
        emitted += estimateTokens(delta);
        yield { type: "delta", text: delta };
      }
      if (event.usage) {
        promptTokens = event.usage.prompt_tokens ?? 0;
        completionTokens = event.usage.completion_tokens ?? 0;
      }
    }
    // Some gateways drop the usage chunk; fall back to the streamed estimate.
    yield { type: "done", promptTokens, completionTokens: completionTokens || emitted };
  },
};

export const openaiTranscription: TranscriptionProvider = {
  id: "openai",
  model: config.provider.transcriptionModel,
  available: true,
  async transcribe(file: File, options?: { language?: string }): Promise<string> {
    // `verbose_json` is what carries segment timings, which is the whole point:
    // a transcript without timecodes cannot produce a citable answer.
    const response = await getClient().audio.transcriptions.create({
      file,
      model: config.provider.transcriptionModel,
      response_format: "verbose_json",
      ...(options?.language ? { language: options.language } : {}),
    });

    const segments = (response as unknown as { segments?: { start: number; text: string }[] }).segments;
    if (!segments || segments.length === 0) {
      return typeof response.text === "string" ? response.text : "";
    }

    // Whisper does not diarise. Rather than invent speaker names, every segment is
    // labelled "Speaker" and the UI tells the user to correct it before ingesting.
    return segments
      .map((segment) => `[${secondsToClock(segment.start)}] Speaker: ${segment.text.trim()}`)
      .join("\n");
  },
};

function secondsToClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

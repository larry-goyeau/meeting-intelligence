import { failure, HttpError, ok } from "@/lib/api";
import { getProviders } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Audio to transcript (the assignment's optional bonus).
 *
 * It returns text rather than ingesting directly, on purpose. Speech-to-text does
 * not diarise: every line comes back labelled "Speaker", and a transcript with no
 * real attribution produces citations that name nobody. So the text lands in an
 * editable box where the user assigns names, and only then gets ingested. A
 * pipeline that hid that step would be quietly producing worse answers.
 */
export async function POST(request: Request) {
  try {
    const providers = getProviders();
    if (!providers.transcription.available) {
      throw new HttpError(
        503,
        "Audio transcription needs a real provider. Set OPENAI_API_KEY and restart to enable it.",
      );
    }

    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) throw new HttpError(400, "Expected an `audio` file field.");
    if (file.size === 0) throw new HttpError(400, "The uploaded audio file is empty.");
    if (file.size > MAX_AUDIO_BYTES) {
      throw new HttpError(413, `Audio is ${Math.round(file.size / 1024 / 1024)} MB; the limit is 25 MB.`);
    }

    const language = form.get("language");
    const transcript = await providers.transcription.transcribe(file, {
      language: typeof language === "string" && language.length > 0 ? language : undefined,
    });

    return ok({
      transcript,
      model: providers.transcription.model,
      needsSpeakerLabels: true,
      note: "Every line is labelled \"Speaker\" because speech-to-text does not identify who is talking. Replace those labels before ingesting, or citations will not name anyone.",
    });
  } catch (error) {
    return failure(error);
  }
}

import { NextResponse } from "next/server";
import OpenAI from "openai";

// We create one OpenAI client instance using your API key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// This route only accepts multipart/form-data that includes a single audio file.
export async function POST(req: Request) {
  try {
    // Parse incoming multipart form data
    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) {
      return NextResponse.json(
        { error: "No audio file received." },
        { status: 400 }
      );
    }

    // Send audio to OpenAI Whisper (speech-to-text)
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "gpt-4o-transcribe",
      // You can request plain text, json, or srt — text is simplest
      response_format: "text",
    });

    // Whisper returns plain text when response_format="text"
    const transcriptText =
      typeof transcription === "string"
        ? transcription
        : (transcription as any)?.text || "";

    return NextResponse.json({
      transcript: transcriptText,
    });
  } catch (err: any) {
    console.error("Transcription error:", err);
    return NextResponse.json(
      { error: err?.message || "Transcription failed." },
      { status: 500 }
    );
  }
}

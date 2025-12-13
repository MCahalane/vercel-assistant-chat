import { list, put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Role = "user" | "assistant";

function cleanLine(s: string) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function formatLine(args: { ts: string; role: Role; text: string }) {
  const safeText = cleanLine(args.text);
  if (!safeText) return "";
  return `[${args.ts}] ${args.role}: ${safeText}\n`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const transcriptId = body?.transcriptId;
    const role = body?.role as Role;
    const text = body?.text;
    const ts = body?.ts || new Date().toISOString();

    if (!transcriptId || typeof transcriptId !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing transcriptId" },
        { status: 400 }
      );
    }

    if (role !== "user" && role !== "assistant") {
      return NextResponse.json(
        { ok: false, error: "Invalid role" },
        { status: 400 }
      );
    }

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing text" },
        { status: 400 }
      );
    }

    const path = `chat-transcripts/${transcriptId}.txt`;
    const newLine = formatLine({ ts, role, text });

    if (!newLine) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    // Find the existing blob (we created it in /start).
    // If it exists, fetch its current contents so we can append a new line.
    const existing = await list({ prefix: path, limit: 5 });
    const match = existing.blobs.find((b) => b.pathname === path);

    let currentText = "";

    if (match?.url) {
      try {
        const r = await fetch(match.url);
        if (r.ok) {
          currentText = await r.text();
        }
      } catch {
        // If fetch fails, we will still try to write a file with just the new line.
      }
    } else {
      // If the file is missing for any reason, create a basic header now.
      currentText =
        `Chat transcript started\n` +
        `TranscriptId: ${transcriptId}\n` +
        `StartedAt: ${new Date().toISOString()}\n\n`;
    }

    const updatedText = currentText + newLine;

    await put(path, updatedText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to append transcript line" },
      { status: 500 }
    );
  }
}

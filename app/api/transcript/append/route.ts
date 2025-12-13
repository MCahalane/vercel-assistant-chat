import { list, put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Role = "user" | "assistant";

function cleanTextBlock(s: string) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normaliseRole(raw: unknown): Role | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();

  if (v === "user") return "user";
  if (v === "assistant") return "assistant";

  if (v === "you") return "user";
  if (v === "ai") return "assistant";
  if (v === "bot") return "assistant";

  return null;
}

function formatLine(args: { ts: string; role: Role; text: string }) {
  const safeText = cleanTextBlock(args.text);
  if (!safeText) return "";
  return `[${args.ts}] ${args.role}: ${safeText}\n`;
}

async function readExistingText(url: string): Promise<string> {
  const r = await fetch(url, { cache: "no-store" as RequestCache });
  if (!r.ok) return "";
  return await r.text();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const transcriptId = body?.transcriptId;
    if (!transcriptId || typeof transcriptId !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing transcriptId" },
        { status: 400 }
      );
    }

    const path = `chat-transcripts/${transcriptId}.txt`;

    const mode =
      typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "append";

    // Mode: finalize (recommended)
    // Payload: { transcriptId, mode: "finalize", fullText: string }
    if (mode === "finalize") {
      const fullText = body?.fullText;

      if (!fullText || typeof fullText !== "string") {
        return NextResponse.json(
          { ok: false, error: "Missing fullText for finalize" },
          { status: 400 }
        );
      }

      const safe = cleanTextBlock(fullText);
      if (!safe) {
        return NextResponse.json({ ok: true, skipped: true });
      }

      const finalText = safe.endsWith("\n") ? safe : safe + "\n";

      await put(path, finalText, {
        access: "public",
        contentType: "text/plain; charset=utf-8",
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      return NextResponse.json({ ok: true, mode: "finalize" });
    }

    // Mode: append (legacy, best-effort)
    // Support payload styles:
    // 1) { transcriptId, role, text, ts }
    // 2) { transcriptId, line, ts? }
    const ts = typeof body?.ts === "string" ? body.ts : new Date().toISOString();

    let newLine = "";

    if (typeof body?.line === "string" && body.line.trim()) {
      const safe = cleanTextBlock(body.line);
      if (!safe) {
        return NextResponse.json({ ok: true, skipped: true });
      }
      newLine = safe.endsWith("\n") ? safe : safe + "\n";
    } else {
      const role = normaliseRole(body?.role);
      const text = body?.text;

      if (!role) {
        return NextResponse.json(
          {
            ok: false,
            error: "Invalid role",
            receivedRole: body?.role ?? null,
            hint: 'Expected role "user" or "assistant" (or "You"/"AI" aliases).',
          },
          { status: 400 }
        );
      }

      if (!text || typeof text !== "string") {
        return NextResponse.json(
          { ok: false, error: "Missing text" },
          { status: 400 }
        );
      }

      newLine = formatLine({ ts, role, text });
      if (!newLine) {
        return NextResponse.json({ ok: true, skipped: true });
      }
    }

    // Read the current blob, append, and write back.
    // This is not atomic, so we keep it only for backwards compatibility.
    const existing = await list({ prefix: path, limit: 5 });
    const match = existing.blobs.find((b) => b.pathname === path);

    let currentText = "";

    if (match?.url) {
      try {
        currentText = await readExistingText(match.url);
      } catch {
        currentText = "";
      }
    }

    if (!currentText) {
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

    return NextResponse.json({ ok: true, mode: "append" });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to write transcript" },
      { status: 500 }
    );
  }
}

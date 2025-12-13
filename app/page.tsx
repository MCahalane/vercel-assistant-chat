"use client";

import React, { useState, useRef, useEffect } from "react";

type ChatMsg = {
  role: "user" | "assistant";
  text: string;
};

type InputMode = "text" | "audio";

export default function Home() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("text");

  // Transcript recording (Blob)
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const transcriptIdRef = useRef<string | null>(null);
  const transcriptFinalizedRef = useRef(false);

  // Audio recording
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);

  // Real audio waveform + loudness tracking
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const maxAmplitudeRef = useRef<number>(0);

  // Banner status inside the iframe
  const [interviewStatus, setInterviewStatus] = useState(
    "Chat in progress…"
  );

  // Tracking for Qualtrics summary
  const chatStartTimeRef = useRef<number | null>(null);
  const chatCompletedRef = useRef(false);

  // Chat container ref for auto scroll
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  // Textarea ref for auto expanding input
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Track transcribing transitions for autofocus
  const wasTranscribingRef = useRef(false);

  // Auto scroll to latest message when messages or loading state change
  useEffect(() => {
    const container = chatContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, isLoading]);

  // Disable right click context menu anywhere inside this page (iframe)
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener("contextmenu", handler);
    return () => {
      document.removeEventListener("contextmenu", handler);
    };
  }, []);

  // Auto expand textarea when input changes
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "0px";
    const maxHeight = 200;
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;
  }, [input]);

  // After voice transcription completes, return focus to textarea and place cursor at end
  useEffect(() => {
    const wasTranscribing = wasTranscribingRef.current;

    if (wasTranscribing && !isTranscribing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {
          // Ignore selection errors in older browsers
        }
      }
    }

    wasTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  // Transcript helpers (save once at end)

  function cleanBlock(s: string) {
    return (s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function buildFinalTranscript(args: {
    transcriptId: string;
    startedAt: string;
    threadId: string | null;
    allMsgs: ChatMsg[];
  }) {
    const headerLines: string[] = [];
    headerLines.push("Chat transcript");
    headerLines.push(`TranscriptId: ${args.transcriptId}`);
    headerLines.push(`StartedAt: ${args.startedAt}`);
    if (args.threadId) headerLines.push(`ThreadId: ${args.threadId}`);
    headerLines.push("");

    const bodyLines: string[] = [];

    for (const m of args.allMsgs) {
      const roleLabel = m.role === "user" ? "User" : "Assistant";
      const text = cleanBlock(m.text);
      if (!text) continue;

      bodyLines.push(`${roleLabel}: ${text}`);
      bodyLines.push("");
    }

    return headerLines.join("\n") + "\n" + bodyLines.join("\n");
  }

  async function ensureTranscriptStarted(): Promise<{
    id: string | null;
    startedAt: string | null;
  }> {
    if (transcriptIdRef.current) {
      return { id: transcriptIdRef.current, startedAt: null };
    }

    try {
      const res = await fetch("/api/transcript/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startedAt: new Date().toISOString(),
          threadId: threadId && threadId.startsWith("thread_") ? threadId : null,
        }),
      });

      const data = await res.json();

      if (!res.ok) return { id: null, startedAt: null };

      if (data && typeof data.transcriptId === "string" && data.transcriptId) {
        transcriptIdRef.current = data.transcriptId;
        setTranscriptId(data.transcriptId);
        return {
          id: data.transcriptId,
          startedAt: typeof data.startedAt === "string" ? data.startedAt : null,
        };
      }

      return { id: null, startedAt: null };
    } catch {
      return { id: null, startedAt: null };
    }
  }

  async function finalizeTranscriptOnce(args: {
    finalMessagesSnapshot: ChatMsg[];
    finalThreadId: string | null;
  }) {
    if (transcriptFinalizedRef.current) return;
    transcriptFinalizedRef.current = true;

    const started = await ensureTranscriptStarted();
    if (!started.id) return;

    const startedAt = started.startedAt || new Date().toISOString();

    const fullText = buildFinalTranscript({
      transcriptId: started.id,
      startedAt,
      threadId: args.finalThreadId,
      allMsgs: args.finalMessagesSnapshot,
    });

    try {
      await fetch("/api/transcript/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptId: started.id,
          mode: "finalize",
          fullText,
        }),
      });
    } catch {
      // Silent: do not interrupt participants
    }
  }

  // Qualtrics summary helpers

  function sendChatCompletionSummary(args: {
    threadId: string | null;
    messageCount: number;
    userMessageCount: number;
    durationSeconds: number | null;
    finishedReason: string;
  }) {
    if (typeof window === "undefined") return;

    const payload = {
      type: "chat_complete",
      threadId: args.threadId,
      messageCount: args.messageCount,
      userMessageCount: args.userMessageCount,
      durationSeconds: args.durationSeconds,
      finishedReason: args.finishedReason,
      completionTimestamp: new Date().toISOString(),
    };

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
    } catch (e) {
      console.error("Failed to post chat completion summary", e);
    }
  }

  function checkForInterviewEnd(args: {
    assistantText: string;
    finalThreadId: string | null;
    messageCount: number;
    userMessageCount: number;
    finalMessagesSnapshot: ChatMsg[];
  }) {
    if (chatCompletedRef.current) return;

    if (
      typeof args.assistantText === "string" &&
      args.assistantText.includes("END_INTERVIEW")
    ) {
      chatCompletedRef.current = true;

      const endTime = Date.now();
      let durationSeconds: number | null = null;

      if (chatStartTimeRef.current) {
        durationSeconds = Math.round(
          (endTime - chatStartTimeRef.current) / 1000
        );
      }

      setInterviewStatus(
        "Chat complete. You may return to the survey and press Next."
      );

      sendChatCompletionSummary({
        threadId: args.finalThreadId,
        messageCount: args.messageCount,
        userMessageCount: args.userMessageCount,
        durationSeconds,
        finishedReason: "END_INTERVIEW",
      });

      void finalizeTranscriptOnce({
        finalMessagesSnapshot: args.finalMessagesSnapshot,
        finalThreadId: args.finalThreadId,
      });
    }
  }

  // Chat sending

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isLoading || isTranscribing) return;

    if (!chatStartTimeRef.current) {
      chatStartTimeRef.current = Date.now();
    }

    const currentMessages = messages;
    const existingUserCount = currentMessages.filter(
      (m) => m.role === "user"
    ).length;
    const newUserMessageCount = existingUserCount + 1;

    const userMsg: ChatMsg = { role: "user", text: trimmed };
    const nextMessagesAfterUser = [...currentMessages, userMsg];

    setMessages(nextMessagesAfterUser);
    setInput("");
    setIsLoading(true);

    try {
      const payload: {
        message: string;
        threadId?: string;
        inputMode: InputMode;
      } = {
        message: trimmed,
        inputMode,
      };

      if (threadId && threadId.startsWith("thread_")) {
        payload.threadId = threadId;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        const errText =
          data?.error || "Something went wrong calling the server.";
        const assistantErrMsg: ChatMsg = { role: "assistant", text: errText };

        const nextMessagesAfterErr = [...nextMessagesAfterUser, assistantErrMsg];
        setMessages(nextMessagesAfterErr);

        setIsLoading(false);
        return;
      }

      const assistantText: string = data.reply || "No reply received.";
      const assistantMsg: ChatMsg = { role: "assistant", text: assistantText };

      const nextMessagesAfterAssistant = [
        ...nextMessagesAfterUser,
        assistantMsg,
      ];
      setMessages(nextMessagesAfterAssistant);

      setInputMode("text");

      let finalThreadId = threadId;
      if (
        typeof data.threadId === "string" &&
        data.threadId.startsWith("thread_")
      ) {
        setThreadId(data.threadId);
        finalThreadId = data.threadId;
      }

      const totalMessagesAfter = currentMessages.length + 2;

      checkForInterviewEnd({
        assistantText,
        finalThreadId: finalThreadId || null,
        messageCount: totalMessagesAfter,
        userMessageCount: newUserMessageCount,
        finalMessagesSnapshot: nextMessagesAfterAssistant,
      });
    } catch (e: any) {
      const msg = e?.message || "Network error.";
      const assistantErrMsg: ChatMsg = { role: "assistant", text: msg };
      setMessages((prev) => [...prev, assistantErrMsg]);
    } finally {
      setIsLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Waveform animation (real audio if available)

  function startWaveformAnimation() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const draw = () => {
      const analyser = analyserRef.current;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#0b1120";
      ctx.fillRect(0, 0, width, height);

      if (analyser) {
        const bufferLength = analyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "#e5e7eb";
        ctx.beginPath();

        const sliceWidth = width / bufferLength;
        let x = 0;
        let frameMaxDeviation = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const deviation = Math.abs(v - 1);

          if (deviation > frameMaxDeviation) {
            frameMaxDeviation = deviation;
          }

          const y = (v * height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        if (frameMaxDeviation > maxAmplitudeRef.current) {
          maxAmplitudeRef.current = frameMaxDeviation;
        }

        ctx.stroke();
      } else {
        const barCount = 80;
        const step = width / barCount;

        ctx.strokeStyle = "#e5e7eb";
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i < barCount; i++) {
          const x = i * step + step / 2;
          const maxBarHeight = height * 0.9;
          const minBarHeight = height * 0.2;
          const barHeight =
            minBarHeight + Math.random() * (maxBarHeight - minBarHeight);

          const yTop = height / 2 - barHeight / 2;
          const yBottom = height / 2 + barHeight / 2;

          ctx.moveTo(x, yTop);
          ctx.lineTo(x, yBottom);
        }

        ctx.stroke();
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
  }

  function stopWaveformAnimation() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b1120";
    ctx.fillRect(0, 0, width, height);
  }

  useEffect(() => {
    if (isRecording) {
      startWaveformAnimation();
    } else {
      stopWaveformAnimation();
    }

    return () => {
      stopWaveformAnimation();
    };
  }, [isRecording]);

  // Voice recording helpers

  async function startRecording() {
    if (isRecording) return;
    if (isLoading || isTranscribing) return;
    if (typeof window === "undefined") return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("Audio recording not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      maxAmplitudeRef.current = 0;
      recordingStartTimeRef.current = Date.now();

      const AudioContextClass =
        window.AudioContext ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).webkitAudioContext;

      if (AudioContextClass) {
        const audioContext = new AudioContextClass();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;

        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
      } else {
        audioContextRef.current = null;
        analyserRef.current = null;
      }

      const mediaRecorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];

      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());

        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
        analyserRef.current = null;

        const endTime = Date.now();
        const durationMs =
          recordingStartTimeRef.current != null
            ? endTime - recordingStartTimeRef.current
            : null;
        recordingStartTimeRef.current = null;

        const maxAmplitude = maxAmplitudeRef.current;
        maxAmplitudeRef.current = 0;

        const showCouldNotUnderstand = () => {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                "Sorry, I couldn't clearly understand that audio. Please try again or type your message.",
            },
          ]);
        };

        const TOO_SHORT_MS = 800;
        const TOO_QUIET_THRESHOLD = 0.08;

        if (
          !durationMs ||
          durationMs < TOO_SHORT_MS ||
          maxAmplitude < TOO_QUIET_THRESHOLD
        ) {
          showCouldNotUnderstand();
          return;
        }

        const audioBlob = new Blob(recordedChunksRef.current, {
          type: "audio/webm",
        });

        (async () => {
          setIsTranscribing(true);
          try {
            const transcript = await sendAudioForTranscription(audioBlob);

            if (!transcript || !transcript.trim()) {
              showCouldNotUnderstand();
              return;
            }

            setInput((prev) =>
              prev && prev.trim().length > 0
                ? `${prev.trim()} ${transcript}`
                : transcript
            );
            setInputMode("audio");
          } finally {
            setIsTranscribing(false);
          }
        })();
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);

      setTimeout(() => {
        if (
          mediaRecorderRef.current === mediaRecorder &&
          mediaRecorder.state === "recording"
        ) {
          mediaRecorder.stop();
          setIsRecording(false);
        }
      }, 180000);
    } catch (error) {
      console.error("Error starting audio recording:", error);
      setIsRecording(false);
    }
  }

  function stopRecording() {
    const mediaRecorder = mediaRecorderRef.current;
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;

    setIsRecording(false);
  }

  // Send audio to backend for transcription

  async function sendAudioForTranscription(
    audioBlob: Blob
  ): Promise<string | null> {
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("Transcription failed:", data.error);
        return null;
      }

      return data.transcript || null;
    } catch (err) {
      console.error("Failed to send audio:", err);
      return null;
    }
  }

  // UI Rendering

  const avatarBase: React.CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: "9999px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 600,
    color: "white",
    flexShrink: 0,
  };

  const textareaPlaceholder = isTranscribing
    ? "Transcribing audio…"
    : "Type your message...";

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "40px auto",
        padding: 16,
        fontFamily: "system-ui, Arial",
      }}
    >
      <style>{`
        @keyframes pulseRecording {
          0% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1); opacity: 0.9; }
        }

        @keyframes typingDotBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
          40% { transform: translateY(-3px); opacity: 1; }
        }

        .typingDots {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 14px;
        }

        .typingDot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: #6b7280;
          opacity: 0.35;
          animation: typingDotBounce 1.1s infinite ease-in-out;
        }

        .typingDot:nth-child(2) { animation-delay: 0.15s; }
        .typingDot:nth-child(3) { animation-delay: 0.3s; }
      `}</style>

      <h1 style={{ fontSize: 22, marginBottom: 4 }}>AI-Assisted Chat</h1>

      <p
        style={{
          fontStyle: "italic",
          marginBottom: 12,
          color: "#444",
        }}
      >
        {interviewStatus}
      </p>

      <div
        ref={chatContainerRef}
        style={{
          border: "1px solid #ccc",
          borderRadius: 8,
          padding: 12,
          height: 420,
          overflowY: "auto",
          background: "#fafafa",
        }}
      >
        {messages.length === 0 && !isLoading && (
          <p style={{ color: "#666" }}>Say hello to start the interview.</p>
        )}

        {messages.map((m, i) => {
          const isUser = m.role === "user";
          const turnGap = isUser ? 10 : 14;

          return (
            <React.Fragment key={i}>
              <div
                style={{
                  display: "flex",
                  justifyContent: isUser ? "flex-end" : "flex-start",
                  marginBottom: turnGap,
                  gap: 6,
                }}
              >
                {!isUser && (
                  <div
                    style={{
                      ...avatarBase,
                      background: "#111827",
                    }}
                  >
                    A
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isUser ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: "#6b7280",
                      marginBottom: 2,
                    }}
                  >
                    {isUser ? "You" : "Assistant"}
                  </span>
                  <div
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      background: isUser ? "#dbeafe" : "#ffffff",
                      border: "1px solid #ddd",
                      whiteSpace: "pre-wrap",
                      fontSize: 14,
                      lineHeight: 1.4,
                    }}
                  >
                    {m.text}
                  </div>
                </div>

                {isUser && (
                  <div
                    style={{
                      ...avatarBase,
                      background: "#2563eb",
                    }}
                  >
                    Y
                  </div>
                )}
              </div>

              {!isUser && (
                <div
                  style={{
                    height: 6,
                  }}
                />
              )}
            </React.Fragment>
          );
        })}

        {isLoading && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-start",
              marginTop: 4,
              gap: 6,
            }}
          >
            <div
              style={{
                ...avatarBase,
                background: "#111827",
              }}
            >
              A
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                  marginBottom: 2,
                }}
              >
                Assistant
              </span>
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: "#ffffff",
                  border: "1px solid #ddd",
                  fontSize: 14,
                  lineHeight: 1.4,
                  color: "#6b7280",
                }}
              >
                <span className="typingDots" aria-label="Assistant is typing">
                  <span className="typingDot" />
                  <span className="typingDot" />
                  <span className="typingDot" />
                </span>
              </div>

              <div style={{ height: 6 }} />
            </div>
          </div>
        )}
      </div>

      {isRecording && (
        <div style={{ marginTop: 12 }}>
          <p
            style={{
              marginBottom: 8,
              fontSize: 13,
              color: "#4b5563",
            }}
          >
            Recording… please speak clearly into your microphone.
          </p>
          <canvas
            ref={canvasRef}
            width={800}
            height={50}
            style={{
              width: "100%",
              height: 50,
              background: "#0b1120",
              borderRadius: 12,
              display: "block",
            }}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => e.preventDefault()}
          placeholder={textareaPlaceholder}
          readOnly={isTranscribing}
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ccc",
            fontSize: 16,
            lineHeight: 1.4,
            minHeight: 60,
            maxHeight: 200,
            resize: "none",
            overflowY: "auto",
            background: isTranscribing ? "#f3f4f6" : "white",
          }}
        />
        <button
          type="button"
          disabled={isLoading || isTranscribing}
          onClick={() => {
            if (isRecording) {
              stopRecording();
            } else {
              startRecording();
            }
          }}
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid #ccc",
            background: isRecording ? "#b91c1c" : "#f9fafb",
            color: isRecording ? "white" : "inherit",
            fontSize: 18,
            cursor: isLoading || isTranscribing ? "default" : "pointer",
            animation: isRecording
              ? "pulseRecording 1.2s ease-in-out infinite"
              : "none",
            transformOrigin: "center",
            opacity: isLoading || isTranscribing ? 0.7 : 1,
          }}
        >
          {isRecording ? "⏹️" : "🎤"}
        </button>
        <button
          onClick={sendMessage}
          disabled={isLoading || isTranscribing || !input.trim()}
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            border: "none",
            background:
              isLoading || isTranscribing || !input.trim()
                ? "#6b7280"
                : "#111827",
            opacity: isLoading || isTranscribing || !input.trim() ? 0.7 : 1,
            color: "white",
            fontSize: 16,
            cursor:
              isLoading || isTranscribing || !input.trim()
                ? "default"
                : "pointer",
          }}
        >
          {isLoading ? "Sending…" : "Send"}
        </button>
      </div>
    </main>
  );
}

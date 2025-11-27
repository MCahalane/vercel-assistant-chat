"use client";

import React, { useState, useRef, useEffect } from "react";

type ChatMsg = {
  role: "user" | "assistant";
  text: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Banner status inside the iframe
  const [interviewStatus, setInterviewStatus] = useState(
    "Interview in progress…"
  );

  // Tracking for Qualtrics summary
  const chatStartTimeRef = useRef<number | null>(null);
  const chatCompletedRef = useRef(false);

  // Chat container ref for auto scroll
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll to latest message when messages or loading state change
  useEffect(() => {
    const container = chatContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, isLoading]);

  // Disable right-click context menu anywhere inside this page (iframe)
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener("contextmenu", handler);
    return () => {
      document.removeEventListener("contextmenu", handler);
    };
  }, []);

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
      console.log("DEBUG: Sending chat_complete summary:", payload);

      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
    } catch (e) {
      console.error("Failed to post chat completion summary", e);
    }
  }

  function checkForInterviewEnd(
    assistantText: string,
    summaryArgs: {
      threadId: string | null;
      messageCount: number;
      userMessageCount: number;
    }
  ) {
    if (chatCompletedRef.current) {
      return;
    }

    if (
      typeof assistantText === "string" &&
      assistantText.includes("END_INTERVIEW")
    ) {
      chatCompletedRef.current = true;

      const endTime = Date.now();
      let durationSeconds: number | null = null;

      if (chatStartTimeRef.current) {
        durationSeconds = Math.round(
          (endTime - chatStartTimeRef.current) / 1000
        );
      }

      // Update the banner inside the iframe
      setInterviewStatus(
        "Interview complete. You may return to the survey and press Next."
      );

      // Send summary up to Qualtrics
      sendChatCompletionSummary({
        threadId: summaryArgs.threadId,
        messageCount: summaryArgs.messageCount,
        userMessageCount: summaryArgs.userMessageCount,
        durationSeconds,
        finishedReason: "END_INTERVIEW",
      });
    }
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    // Start the timer on the first user message
    if (!chatStartTimeRef.current) {
      chatStartTimeRef.current = Date.now();
    }

    // For counting, capture the current messages array once at the start
    const currentMessages = messages;
    const existingUserCount = currentMessages.filter(
      (m) => m.role === "user"
    ).length;
    const newUserMessageCount = existingUserCount + 1;

    const userMsg: ChatMsg = { role: "user", text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const payload: { message: string; threadId?: string } = {
        message: trimmed,
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
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: errText },
        ]);
        setIsLoading(false);
        return;
      }

      const assistantText: string = data.reply || "No reply received.";
      const assistantMsg: ChatMsg = {
        role: "assistant",
        text: assistantText,
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // Update threadId only if server sent a real one
      let finalThreadId = threadId;
      if (
        typeof data.threadId === "string" &&
        data.threadId.startsWith("thread_")
      ) {
        setThreadId(data.threadId);
        finalThreadId = data.threadId;
      }

      const totalMessagesAfter = currentMessages.length + 2;

      // Check if this message ends the interview; if yes, post the summary
      checkForInterviewEnd(assistantText, {
        threadId: finalThreadId || null,
        messageCount: totalMessagesAfter,
        userMessageCount: newUserMessageCount,
      });
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: e?.message || "Network error.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") sendMessage();
  }

  // Small helpers for avatar style
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

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "40px auto",
        padding: 16,
        fontFamily: "system-ui, Arial",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>
        My OpenAI Assistant Chat
      </h1>

      {/* Interview status banner inside the iframe */}
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
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                marginBottom: 10,
                gap: 6,
              }}
            >
              {/* Assistant avatar on the left */}
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

              {/* User avatar on the right */}
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
          );
        })}

        {/* Typing indicator bubble for assistant */}
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
                …
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => e.preventDefault()}
          placeholder="Type your message..."
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ccc",
            fontSize: 16,
          }}
        />
        <button
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            border: "none",
            background: isLoading || !input.trim() ? "#6b7280" : "#111827",
            opacity: isLoading || !input.trim() ? 0.7 : 1,
            color: "white",
            fontSize: 16,
            cursor: isLoading || !input.trim() ? "default" : "pointer",
          }}
        >
          {isLoading ? "Sending…" : "Send"}
        </button>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

interface Message {
  id: string;
  text: string;
  senderId: string;
  timestamp: Date;
  isOwn: boolean;
  status?: "sent" | "delivered" | "read";
}

const ROOM_ID = "private-chat-room";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [otherUserTyping, setOtherUserTyping] = useState(false);
  const [userId] = useState(() => Math.random().toString(36).substring(2, 11));
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chatVisibleRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    socketRef.current = io();

    socketRef.current.on("connect", () => {
      setIsConnected(true);
      socketRef.current?.emit("join-room", ROOM_ID);
    });

    socketRef.current.on("disconnect", () => {
      setIsConnected(false);
    });

    socketRef.current.on("receive-message", (data: Message) => {
      if (data.senderId !== userId) {
        setMessages((prev) => [...prev, { ...data, timestamp: new Date(data.timestamp), isOwn: false, status: "delivered" }]);
        socketRef.current?.emit("message-delivered", { roomId: ROOM_ID, messageId: data.id });
      }
    });

    socketRef.current.on("message-delivered", (data: { messageId: string; deliveredTo: string }) => {
      if (data.deliveredTo !== userId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === data.messageId && msg.isOwn ? { ...msg, status: "delivered" } : msg
          )
        );
      }
    });

    socketRef.current.on("message-read", (data: { messageId: string; readBy: string }) => {
      if (data.readBy !== userId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === data.messageId && msg.isOwn ? { ...msg, status: "read" } : msg
          )
        );
      }
    });

    socketRef.current.on("user-typing", (data: { userId: string; isTyping: boolean }) => {
      if (data.userId !== userId) {
        setOtherUserTyping(data.isTyping);
      }
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [userId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, otherUserTyping]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      chatVisibleRef.current = !document.hidden;
      if (chatVisibleRef.current && socketRef.current) {
        const unreadMessages = messages.filter((m) => !m.isOwn && m.status !== "read");
        unreadMessages.forEach((msg) => {
          socketRef.current?.emit("message-read", { roomId: ROOM_ID, messageId: msg.id });
        });
        setMessages((prev) =>
          prev.map((msg) =>
            !msg.isOwn && msg.status !== "read" ? { ...msg, status: "read" } : msg
          )
        );
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [messages, userId]);

  useEffect(() => {
    if (chatVisibleRef.current && socketRef.current) {
      const unreadMessages = messages.filter((m) => !m.isOwn && m.status !== "read");
      unreadMessages.forEach((msg) => {
        socketRef.current?.emit("message-read", { roomId: ROOM_ID, messageId: msg.id });
      });
      if (unreadMessages.length > 0) {
        setMessages((prev) =>
          prev.map((msg) =>
            !msg.isOwn && msg.status !== "read" ? { ...msg, status: "read" } : msg
          )
        );
      }
    }
  }, [messages, userId]);

  const sendMessage = () => {
    if (!input.trim() || !socketRef.current) return;

    const newMessage: Message = {
      id: Math.random().toString(36).substring(2, 11),
      text: input.trim(),
      senderId: userId,
      timestamp: new Date(),
      isOwn: true,
      status: "sent",
    };

    setMessages((prev) => [...prev, newMessage]);
    socketRef.current.emit("send-message", { ...newMessage, roomId: ROOM_ID });
    setInput("");
    setIsTyping(false);
    socketRef.current.emit("typing", { roomId: ROOM_ID, isTyping: false });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    textareaRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    if (!isTyping && value.trim()) {
      setIsTyping(true);
      socketRef.current?.emit("typing", { roomId: ROOM_ID, isTyping: true });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      socketRef.current?.emit("typing", { roomId: ROOM_ID, isTyping: false });
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case "read":
        return (
          <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z" />
          </svg>
        );
      case "delivered":
        return (
          <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        );
    }
  };

  return (
    <div className="flex flex-col h-screen h-dvh bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm sticky top-0 z-10">
        <h1 className="text-lg font-semibold text-gray-900 truncate">Private Chat</h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-xs text-gray-500 capitalize hidden sm:inline">{isConnected ? "connected" : "disconnected"}</span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 space-y-4 pb-2" ref={messagesEndRef}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isOwn ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] px-4 py-2.5 rounded-2xl ${
                msg.isOwn
                  ? "bg-blue-600 text-white rounded-br-none"
                  : "bg-white text-gray-900 rounded-bl-none shadow-sm"
              }`}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.text}</p>
              <div className="flex items-center justify-end gap-1 mt-1">
                <p className={`text-xs ${msg.isOwn ? "text-blue-100" : "text-gray-400"}`}>
                  {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
                {msg.isOwn && getStatusIcon(msg.status)}
              </div>
            </div>
          </div>
        ))}

        {otherUserTyping && (
          <div className="flex justify-start">
            <div className="bg-white px-4 py-2 rounded-2xl rounded-bl-none shadow-sm">
              <div className="flex gap-1 text-gray-500">
                <span className="animate-bounce">●</span>
                <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>●</span>
                <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>●</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      <footer className="bg-white border-t border-gray-200 p-4 pb-safe pb-4 sticky bottom-0">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1 bg-gray-100 border border-gray-300 rounded-2xl px-4 py-3 text-base text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent max-h-40 min-h-[48px]"
            rows={1}
            style={{ fontSize: "16px" }}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            inputMode="text"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || !isConnected}
            className="bg-blue-600 text-white p-3 rounded-xl hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-w-[48px] min-h-[48px] flex-shrink-0"
            aria-label="Send message"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
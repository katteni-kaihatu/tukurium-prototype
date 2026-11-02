import type { Participant } from "@tukurium/shared";
import { create } from "zustand";
import type { ConnectionStatus } from "../net/Connection";

interface SessionState {
  myName: string;
  myId: string | null;
  status: ConnectionStatus;
  participants: Record<string, Participant>;
  set(partial: Partial<Omit<SessionState, "set">>): void;
}

const NAME_KEY = "tukurium.name";

function loadName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    const name = `ゲスト${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem(NAME_KEY, name);
    return name;
  } catch {
    return `ゲスト${Math.floor(1000 + Math.random() * 9000)}`;
  }
}

export const useSession = create<SessionState>((set) => ({
  myName: loadName(),
  myId: null,
  status: "connecting",
  participants: {},
  set: (partial) => set(partial),
}));

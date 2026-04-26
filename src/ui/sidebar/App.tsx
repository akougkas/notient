import { signal } from "@preact/signals";
import { ChatTab } from "./components/ChatTab";
import { type FooterState, StatusFooter } from "./components/StatusFooter";
import { StreamTab } from "./components/StreamTab";
import { TabBar } from "./components/TabBar";
import { VitalsTab } from "./components/VitalsTab";
import { activeTab } from "./state";

export interface AgentRun {
  id: number;
  agent: string;
  trigger: string;
  ok: boolean;
  proposals: number;
  durationMs: number;
  error?: string;
  finishedAt: number;
}

export interface SidebarActions {
  openCoAuthor: () => void;
  openApprovals: () => void;
  openAwaken: () => void;
  // Optional until Task 9 wires the Search surface; keeps main.ts compiling.
  openSearch?: () => void;
}

export const footerState = signal<FooterState>({ endpoints: [], noteCount: 0 });
export const pendingApprovalsState = signal<number>(0);
export const sidebarActions = signal<SidebarActions | null>(null);
export const tickState = signal<number>(0);

// Retained as a no-op buffer so existing main.ts producers keep compiling.
// The Stream tab in Task 2 will subsume its rendering responsibility.
export const recentRunsState = signal<AgentRun[]>([]);

export function App() {
  const tab = activeTab.value;
  const pending = pendingApprovalsState.value;
  void tickState.value;

  return (
    <div class="notient-app">
      <header class="notient-header">
        <h2>Notient</h2>
        <p class="notient-subtitle">Mind layer online</p>
      </header>
      <TabBar pendingApprovals={pending} />
      <main class="notient-body">
        {tab === "stream" ? <StreamTab /> : null}
        {tab === "vitals" ? <VitalsTab /> : null}
        {tab === "chat" ? <ChatTab /> : null}
      </main>
      <StatusFooter state={footerState} />
    </div>
  );
}

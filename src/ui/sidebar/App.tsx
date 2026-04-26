import { signal } from "@preact/signals";
import { type FooterState, StatusFooter } from "./components/StatusFooter";

export const footerState = signal<FooterState>({ endpoints: [], noteCount: 0 });

export function App() {
  return (
    <div class="notient-app">
      <header class="notient-header">
        <h2>Notient</h2>
        <p class="notient-subtitle">Foundation phase. UI lands in Phase 4.</p>
      </header>
      <main class="notient-body">
        <p>Plugin loaded. Substrate online.</p>
      </main>
      <StatusFooter state={footerState} />
    </div>
  );
}

import type { EventBus } from "../events/eventBus";

export interface UserEvolutionState {
  currentFocus: string; // e.g., "Deep Work", "Exploration", "Triage"
  sentiment: "positive" | "neutral" | "frustrated" | "curious";
  evolutionaryStage: "gathering" | "synthesizing" | "polishing";
  recentTopics: string[];
}

export class UserEvolutionService {
  readonly id = "user-evolution";
  private state: UserEvolutionState = {
    currentFocus: "Exploration",
    sentiment: "neutral",
    evolutionaryStage: "gathering",
    recentTopics: [],
  };

  constructor(private eventBus: EventBus) {}

  async load(): Promise<void> {
    // In v0.1: Start with default state
    // Future: Load from persistence
    this.subscribeToEvents();
  }

  async unload(): Promise<void> {
    // Save state if needed
  }

  getState(): UserEvolutionState {
    return { ...this.state };
  }

  updateState(partial: Partial<UserEvolutionState>): void {
    this.state = { ...this.state, ...partial };
    console.log("[UserEvolution] State updated:", this.state);
  }

  private subscribeToEvents(): void {
    // Heuristic: Update state based on user actions
    // This is a simplified v0.1 implementation
    this.eventBus.on("agent:task-update", (payload) => {
      if (payload.task.status === "completed") {
        this.analyzeTaskForEvolution(payload.task);
      }
    });
  }

  private analyzeTaskForEvolution(taskPayload: any): void {
    // Simple heuristic updates
    if (taskPayload.type === "synthesis") {
      this.updateState({ evolutionaryStage: "synthesizing", currentFocus: "Deep Work" });
    } else if (taskPayload.type === "clipping") {
      this.updateState({ evolutionaryStage: "gathering", currentFocus: "Exploration" });
    }

    // Update recent topics if available
    // (Placeholder for topic extraction logic)
  }
}

/**
 * Sidebar module - Re-exports sidebar view and components
 *
 * This module provides a clean API for the sidebar functionality.
 */

// Main view
export { NotientSidebarView } from "../sidebar";

// Components
export { NoteCard } from "./components/NoteCard";
export { QuickActions, createNoteQuickActions } from "./components/QuickActions";
export type { QuickAction } from "./components/QuickActions";
export { InsightStream } from "./components/InsightStream";
export { SidebarFooter } from "./components/SidebarFooter";
export type { ServiceHealth, IndexManagerStats } from "./components/SidebarFooter";

// Services (re-export for convenience)
export { NoteVitalsCalculator } from "../../services/noteVitalsCalculator";
export type { NoteVitals, IndexManagerLike } from "../../services/noteVitalsCalculator";
export { InsightGenerator } from "../../services/insightGenerator";
export type { Insight, InsightGeneratorCallbacks } from "../../services/insightGenerator";

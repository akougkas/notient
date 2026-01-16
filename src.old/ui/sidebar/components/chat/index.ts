/**
 * Chat UI Components
 *
 * Rich chat interface components for the enhanced chat experience.
 */

// Main view
export { RichChatView, createActivityItem } from "./RichChatView";
export type { ChatContext, DelegationState, ActivityItem } from "./RichChatView";

// Message components
export { MessageBubble, StreamingBubble } from "./MessageBubble";
export type { RichChatMessage, MessageAction } from "./MessageBubble";

// Supporting components
export { ThinkingBlock, ThinkingIndicator } from "./ThinkingBlock";
export { StatsPanel, MiniStats } from "./StatsPanel";
export { ActivityTrail, ActivityIndicator } from "./ActivityTrail";
export { DelegationBanner } from "./DelegationBanner";
export { MarkdownRenderer, renderMarkdownToString } from "./MarkdownRenderer";

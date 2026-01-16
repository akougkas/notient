/**
 * Search Strategies Module
 *
 * Exports all search strategy implementations.
 */

export { NativeSearch } from "./native";
export { QuickSearchStrategy } from "./quick";
export { BalancedSearchStrategy } from "./balanced";
export { DeepSearchStrategy } from "./deep";

export type {
  SearchStrategy,
  SearchMode,
  SearchProgress,
  StrategyContext,
  StrategySearchOptions,
  NativeMatch,
  ResultSource,
  AttributedSearchResult,
} from "./types";

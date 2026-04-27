import type { JSX } from "preact";
import type { SearchFilters } from "../../../core/search/types";
import type { ConnectivityTier, Maturity } from "../../../core/vitals/types";
import { searchActions, searchFilters } from "../state";

const MATURITY_OPTIONS: Maturity[] = ["raw", "draft", "review", "mature"];
const CONNECTIVITY_OPTIONS: ConnectivityTier[] = ["isolated", "sparse", "connected", "hub"];
const AGENT_OPTIONS: string[] = [
  "linker",
  "synthesizer",
  "contradictionHunter",
  "maturityAdvancer",
];

export interface FilterRowProps {
  open?: boolean;
}

export function FilterRow({ open = true }: FilterRowProps = {}) {
  const filters = searchFilters.value;

  const update = (next: SearchFilters): void => {
    searchFilters.value = next;
    searchActions.value?.runSearch();
  };

  const toggleMaturity = (option: Maturity): void => {
    const current = filters.maturity ?? [];
    const exists = current.includes(option);
    const nextList = exists ? current.filter((value) => value !== option) : [...current, option];
    update({ ...filters, maturity: nextList.length > 0 ? nextList : undefined });
  };

  const toggleAgent = (option: string): void => {
    const current = filters.agents ?? [];
    const exists = current.includes(option);
    const nextList = exists ? current.filter((value) => value !== option) : [...current, option];
    update({ ...filters, agents: nextList.length > 0 ? nextList : undefined });
  };

  const toggleConnectivity = (option: ConnectivityTier): void => {
    const current = filters.connectivityTiers ?? [];
    const exists = current.includes(option);
    const nextList = exists ? current.filter((value) => value !== option) : [...current, option];
    update({ ...filters, connectivityTiers: nextList.length > 0 ? nextList : undefined });
  };

  const togglePending = (): void => {
    update({ ...filters, hasPendingProposals: filters.hasPendingProposals ? undefined : true });
  };

  const onConfidenceInput = (event: JSX.TargetedEvent<HTMLInputElement>): void => {
    const raw = event.currentTarget.value;
    const parsed = raw === "" ? undefined : Number(raw);
    update({
      ...filters,
      minConfidence: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
  };

  const onFromDateInput = (event: JSX.TargetedEvent<HTMLInputElement>): void => {
    const raw = event.currentTarget.value;
    const parsed = raw === "" ? undefined : Date.parse(raw);
    update({
      ...filters,
      fromDate: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
  };

  const onToDateInput = (event: JSX.TargetedEvent<HTMLInputElement>): void => {
    const raw = event.currentTarget.value;
    const parsed = raw === "" ? undefined : Date.parse(raw);
    update({
      ...filters,
      toDate: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
  };

  return (
    <section
      class="notient-search__filters notient-search-filters"
      aria-label="Search filters"
      hidden={!open}
    >
      <div class="notient-search-filters__group" data-group="maturity">
        <span class="notient-search-filters__label">Maturity</span>
        {MATURITY_OPTIONS.map((option) => {
          const active = filters.maturity?.includes(option) ?? false;
          return (
            <button
              key={option}
              type="button"
              data-filter="maturity"
              data-value={option}
              class={`notient-filter-chip${active ? " notient-filter-chip--active" : ""}`}
              aria-pressed={active}
              onClick={() => toggleMaturity(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      <div class="notient-search-filters__group" data-group="agents">
        <span class="notient-search-filters__label">Agent</span>
        {AGENT_OPTIONS.map((option) => {
          const active = filters.agents?.includes(option) ?? false;
          return (
            <button
              key={option}
              type="button"
              data-filter="agent"
              data-value={option}
              class={`notient-filter-chip${active ? " notient-filter-chip--active" : ""}`}
              aria-pressed={active}
              onClick={() => toggleAgent(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      <div class="notient-search-filters__group" data-group="connectivity">
        <span class="notient-search-filters__label">Connectivity</span>
        {CONNECTIVITY_OPTIONS.map((option) => {
          const active = filters.connectivityTiers?.includes(option) ?? false;
          return (
            <button
              key={option}
              type="button"
              data-filter="connectivity"
              data-value={option}
              class={`notient-filter-chip${active ? " notient-filter-chip--active" : ""}`}
              aria-pressed={active}
              onClick={() => toggleConnectivity(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      <div class="notient-search-filters__group" data-group="proposals">
        <button
          type="button"
          data-filter="proposals"
          class={`notient-filter-chip${
            filters.hasPendingProposals ? " notient-filter-chip--active" : ""
          }`}
          aria-pressed={Boolean(filters.hasPendingProposals)}
          onClick={togglePending}
        >
          Pending proposals
        </button>
      </div>
      <div class="notient-search-filters__group" data-group="ranges">
        <label class="notient-search-filters__range">
          <span>Min confidence</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={filters.minConfidence ?? ""}
            onInput={onConfidenceInput}
          />
        </label>
        <label class="notient-search-filters__range">
          <span>From</span>
          <input
            type="date"
            value={filters.fromDate ? toDateInputValue(filters.fromDate) : ""}
            onInput={onFromDateInput}
          />
        </label>
        <label class="notient-search-filters__range">
          <span>To</span>
          <input
            type="date"
            value={filters.toDate ? toDateInputValue(filters.toDate) : ""}
            onInput={onToDateInput}
          />
        </label>
      </div>
    </section>
  );
}

function toDateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

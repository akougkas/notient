import { signal } from "@preact/signals";

export type SidebarTab = "stream" | "vitals" | "chat";

export const activeTab = signal<SidebarTab>("stream");

export function setActiveTab(tab: SidebarTab): void {
  activeTab.value = tab;
}

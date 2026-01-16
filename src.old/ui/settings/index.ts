/**
 * Settings module - Re-exports core settings functionality
 *
 * This module provides a clean API for settings management.
 */

export { loadSettings, saveSettings, validateSettings, NotientSettingTab } from "./SettingsTab";
export { IndexManagementPanel } from "./panels/IndexManagementPanel";
export type { IndexInfo, IndexManagerInterface } from "./panels/IndexManagementPanel";

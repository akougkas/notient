/**
 * Notient v0.1.0 - Phase Galaxy
 * AI-powered vault management for Obsidian using local LLMs only.
 */

import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";

export default class NotientPlugin extends Plugin {
  settings: NotientSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    // TODO: Initialize kernel
    // TODO: Register sidebar view
    // TODO: Register commands
  }

  async onunload(): Promise<void> {
    // TODO: Cleanup kernel services
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

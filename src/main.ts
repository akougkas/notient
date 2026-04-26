import { Plugin } from "obsidian";

export default class NotientPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("[Notient] loading v1.0.0-foundation");
  }

  async onunload(): Promise<void> {
    console.log("[Notient] unloading");
  }
}

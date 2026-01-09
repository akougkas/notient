/**
 * Notient Sidebar View - Thin Preact Wrapper
 *
 * This is a minimal ItemView that mounts the Preact App component.
 * All rendering logic lives in App.tsx and child components.
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { VIEW_TYPE_SIDEBAR } from "../../core/constants";
import type { Kernel } from "../../core/kernel";
import { App } from "./App";
import { KernelProvider } from "./context/KernelContext";

export class NotientSidebarView extends ItemView {
	private containerEl_: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private kernel: Kernel,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SIDEBAR;
	}

	getDisplayText(): string {
		return "Notient";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notient-sidebar--v2");
		this.containerEl_ = container;

		render(
			<KernelProvider kernel={this.kernel} app={this.app}>
				<App />
			</KernelProvider>,
			this.containerEl_,
		);
	}

	async onClose(): Promise<void> {
		if (this.containerEl_) {
			render(null, this.containerEl_);
		}
		this.containerEl_ = null;
	}
}

/**
 * useNoteVitals - Hook for tracking current note vitals
 *
 * Subscribes to workspace changes and calculates vitals for the active note.
 */

import { signal, type Signal } from "@preact/signals";
import type { TFile } from "obsidian";
import { useEffect, useMemo } from "preact/hooks";
import { ParaDetector } from "../../../core/para/detector";
import {
	type IndexManagerLike,
	type NoteVitals,
	NoteVitalsCalculator,
} from "../../../services/noteVitalsCalculator";
import { useApp, useKernel } from "../context/KernelContext";

// Shared signal for note vitals (singleton per sidebar instance)
const noteVitalsSignal: Signal<NoteVitals | null> = signal(null);
const isLoadingSignal: Signal<boolean> = signal(false);

export interface UseNoteVitalsResult {
	noteVitals: Signal<NoteVitals | null>;
	isLoading: Signal<boolean>;
	hasNote: boolean;
	refresh: () => Promise<void>;
}

export function useNoteVitals(): UseNoteVitalsResult {
	const kernel = useKernel();
	const app = useApp();

	// Create calculator instance
	const calculator = useMemo(() => {
		const paraDetector = new ParaDetector(kernel.settings);
		return new NoteVitalsCalculator(app, paraDetector);
	}, [app, kernel.settings]);

	// Refresh function
	const refresh = async () => {
		const activeFile = app.workspace.getActiveFile();

		if (!activeFile || activeFile.extension !== "md") {
			noteVitalsSignal.value = null;
			return;
		}

		isLoadingSignal.value = true;
		try {
			const indexManager =
				kernel.getService<IndexManagerLike>("indexManager");
			const vitals = await calculator.calculate(activeFile, indexManager);
			noteVitalsSignal.value = vitals;
		} catch (error) {
			console.error("[useNoteVitals] Error calculating vitals:", error);
			noteVitalsSignal.value = null;
		} finally {
			isLoadingSignal.value = false;
		}
	};

	// Subscribe to workspace changes
	useEffect(() => {
		// Initial load
		void refresh();

		// Subscribe to active leaf changes
		const leafChangeRef = app.workspace.on("active-leaf-change", () => {
			void refresh();
		});

		// Subscribe to file modifications
		const modifyRef = app.vault.on("modify", (file) => {
			if (
				noteVitalsSignal.value?.path === file.path &&
				file instanceof Object &&
				"extension" in file &&
				(file as TFile).extension === "md"
			) {
				void refresh();
			}
		});

		return () => {
			app.workspace.offref(leafChangeRef);
			app.vault.offref(modifyRef);
		};
	}, [app, calculator]);

	return {
		noteVitals: noteVitalsSignal,
		isLoading: isLoadingSignal,
		hasNote: noteVitalsSignal.value !== null,
		refresh,
	};
}

/**
 * Get backlink preview text for the current note
 */
export function useBacklinkPreview(): string {
	const app = useApp();
	const kernel = useKernel();

	const calculator = useMemo(() => {
		const paraDetector = new ParaDetector(kernel.settings);
		return new NoteVitalsCalculator(app, paraDetector);
	}, [app, kernel.settings]);

	const activeFile = app.workspace.getActiveFile();
	if (!activeFile) return "";

	return calculator.getBacklinkPreview(activeFile);
}

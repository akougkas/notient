/**
 * useNoteVitals - Hook for tracking current note vitals
 *
 * Subscribes to workspace changes and calculates vitals for the active note.
 */

import { type Signal, signal } from "@preact/signals";
import type { TFile } from "obsidian";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { ParaDetector } from "../../../core/para/detector";
import {
  type IndexManagerLike,
  type NoteVitals,
  NoteVitalsCalculator,
} from "../../../services/noteVitalsCalculator";
import { useApp, useEventBus, useKernel } from "../context/KernelContext";

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

  // Track refresh function in ref for event subscription
  const refreshRef = useRef<() => Promise<void>>();

  // Refresh function
  const refresh = async () => {
    // Wait for services to initialize - silently skip if not ready
    if (!kernel.isServicesInitialized) {
      return;
    }

    const activeFile = app.workspace.getActiveFile();

    if (!activeFile || activeFile.extension !== "md") {
      noteVitalsSignal.value = null;
      return;
    }

    isLoadingSignal.value = true;
    try {
      const indexManager = kernel.getService<IndexManagerLike>("indexManager");
      if (!indexManager) {
        // Services initialized but IndexManager not registered - unexpected
        noteVitalsSignal.value = null;
        return;
      }
      const vitals = await calculator.calculate(activeFile, indexManager);
      noteVitalsSignal.value = vitals;
    } catch (error) {
      console.error("[useNoteVitals] Error calculating vitals:", error);
      noteVitalsSignal.value = null;
    } finally {
      isLoadingSignal.value = false;
    }
  };

  // Keep refresh ref updated
  refreshRef.current = refresh;

  // Trigger refresh when services become ready
  useEventBus("services:initialized", () => {
    void refreshRef.current?.();
  });

  // Subscribe to workspace changes
  useEffect(() => {
    // Initial load (will be skipped if services not ready, then triggered by event above)
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

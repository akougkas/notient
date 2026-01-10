import { signal } from "@preact/signals";
import { Notice, setIcon } from "obsidian";
import { useEffect, useState } from "preact/hooks";
import { useKernel } from "../context/KernelContext";
import { BaseModal } from "./BaseModal";
import type { LLMProvider } from "../../../core/llm/provider";

interface ModelSelectorModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentModel: string | null;
}

interface Model {
    id: string;
    name: string;
    path: string;
}

export function ModelSelectorModal({ isOpen, onClose, currentModel }: ModelSelectorModalProps) {
    const kernel = useKernel();
    const [models, setModels] = useState<Model[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchModels = async () => {
        setIsLoading(true);
        setError(null);
        try {
            // Get the LLM Provider service
            const llmProvider = kernel.getService<LLMProvider>("llmProvider");

            if (!llmProvider) {
                // If service isn't ready (e.g. LM Studio not connected), try to get the raw service?
                // Or just report error. The user is asking to 'configure' it, so it implies we should be able to see models.
                // But the llmProvider *is* the configured provider.
                // Let's check kernel capabilities or health.
                const health = kernel.serviceHealth;
                if (health.lmstudio.status !== "healthy") {
                    throw new Error("LM Studio is not connected. Please start LM Studio and ensure the server is running.");
                }
                throw new Error("AI Service initializing...");
            }

            // Use the standard interface to list models
            // This is defined in src/core/llm/provider.ts
            const modelIds = await llmProvider.listModels();

            if (!modelIds || modelIds.length === 0) {
                setError("No models found. Please load a model in LM Studio.");
                setModels([]);
                return;
            }

            // Map string IDs to Model objects
            const mappedModels: Model[] = modelIds.map(id => ({
                id: id,
                name: id.split('/').pop() || id,
                path: id
            }));

            setModels(mappedModels);

        } catch (err) {
            console.error("[ModelSelector] Failed to fetch models", err);
            const msg = err instanceof Error ? err.message : String(err);
            // Friendly error message
            if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
                setError("Could not connect to LM Studio. Is the server running?");
            } else {
                setError(`Error: ${msg}`);
            }
            setModels([]);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchModels();
        }
    }, [isOpen]);

    const handleSelect = async (modelId: string) => {
        try {
            console.log(`[ModelSelector] Switching to model: ${modelId}`);

            // 1. Update Settings
            // We assume we are switching the 'Reasoning' (Chat) model since this is the primary agent model.
            kernel.settings.lmstudio.reasoningModel = modelId;
            kernel.updateSettings(kernel.settings); // Update persistent reference

            // 2. Save to disk
            await kernel.saveSettings();

            // 3. Emit Event to trigger re-initialization in main.ts
            // main.ts listens for "settings:changed" and checks for lmlstudio.reasoningModel
            kernel.eventBus.emit("settings:changed", { changedFields: ["lmstudio.reasoningModel"] });

            new Notice(`Switched to ${modelId}`);
            onClose();
        } catch (err) {
            console.error("[ModelSelector] Failed to update settings", err);
            new Notice(`Failed to switch model: ${err}`);
        }
    };

    return (
        <BaseModal isOpen={isOpen} onClose={onClose} title="Select AI Model">
            <div class="nv2-model-selector">
                {/* Header / Actions */}
                <div class="nv2-model-list-actions">
                    <button class="nv2-btn nv2-btn-secondary" onClick={fetchModels} disabled={isLoading}>
                        {isLoading ? "Scanning..." : "Refresh Models"}
                    </button>
                    <div class="nv2-provider-badge">
                        <span class={`nv2-status-dot ${!error ? 'nv2-status-dot--healthy' : 'nv2-status-dot--error'}`}></span>
                        LM Studio
                    </div>
                </div>

                {/* Error State */}
                {error && (
                    <div class="nv2-error-banner">
                        <span class="nv2-error-icon">!</span>
                        {error}
                    </div>
                )}

                {/* List */}
                <div class="nv2-model-list">
                    {models.length === 0 && !isLoading && !error && (
                        <div class="nv2-empty-state-small">
                            No models found. Check LM Studio.
                        </div>
                    )}

                    {models.map(model => (
                        <button
                            key={model.id}
                            class={`nv2-modal-list-item ${currentModel === model.id ? 'nv2-modal-list-item--active' : ''}`}
                            onClick={() => handleSelect(model.id)}
                        >
                            <div class="nv2-item-main">
                                <span class="nv2-item-label">{model.name}</span>
                                <span class="nv2-item-detail">{model.path}</span>
                            </div>
                            {currentModel === model.id && <span class="nv2-check-icon">✓</span>}
                        </button>
                    ))}
                </div>
            </div>
        </BaseModal>
    );
}

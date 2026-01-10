import { signal } from "@preact/signals";
import { Notice } from "obsidian";
import { useEffect, useState } from "preact/hooks";
import { useKernel } from "../context/KernelContext";
import { BaseModal } from "./BaseModal";
import type { IndexStatus } from "../types";
import type { IndexManager, DiscoveredIndex } from "../../../services/indexManager";

interface IndexDashboardModalProps {
    isOpen: boolean;
    onClose: () => void;
    indexStatus: IndexStatus;
}

export function IndexDashboardModal({ isOpen, onClose, indexStatus }: IndexDashboardModalProps) {
    const kernel = useKernel();
    const [indices, setIndices] = useState<DiscoveredIndex[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [currentSystemDim, setCurrentSystemDim] = useState<number>(0);

    const loadIndices = async () => {
        setIsLoading(true);
        try {
            const indexManager = kernel.getService<IndexManager>("indexManager");
            if (indexManager) {
                // Get current system dimension to check compatibility
                const dim = indexManager.getDimension();
                setCurrentSystemDim(dim);

                // Discover available indices on disk
                const discovered = await indexManager.discoverIndices();
                setIndices(discovered);
            }
        } catch (e) {
            console.error("[IndexDashboard] Failed to load indices", e);
            new Notice(`Error loading indices: ${String(e)}`);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadIndices();
        }
    }, [isOpen]);

    const handleSwitchIndex = async (indexPath: string) => {
        try {
            const indexManager = kernel.getService<IndexManager>("indexManager");
            if (indexManager) {
                new Notice("Switching index...");
                await indexManager.switchToIndex(indexPath);
                // switch calls reload, so UI will refresh
                onClose();
            }
        } catch (e) {
            console.error("[IndexDashboard] Failed to switch index", e);
            new Notice(`Failed to switch index: ${String(e)}`);
        }
    };

    // Helper to format date
    const formatDate = (date: Date | null) => {
        if (!date) return "Unknown date";
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    };

    return (
        <BaseModal isOpen={isOpen} onClose={onClose} title="Index Dashboard">
            <div class="nv2-index-dashboard">
                {/* Current Stats */}
                <div class="nv2-stats-grid">
                    <div class="nv2-stat-card">
                        <span class="nv2-stat-value">{indexStatus.noteCount}</span>
                        <span class="nv2-stat-label">Notes Indexed</span>
                    </div>
                    <div class="nv2-stat-card">
                        <span class="nv2-stat-value">{indexStatus.isIndexing ? "Indexing" : "Ready"}</span>
                        <span class="nv2-stat-label">Status</span>
                    </div>
                    <div class="nv2-stat-card">
                        <span class="nv2-stat-value">{currentSystemDim > 0 ? `${currentSystemDim}d` : "-"}</span>
                        <span class="nv2-stat-label">Dimension</span>
                    </div>
                </div>

                <div class="nv2-section-header">
                    <h4 class="nv2-section-title">Available Indices</h4>
                    <button class="nv2-btn-icon" onClick={loadIndices} title="Refresh List">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" /></svg>
                    </button>
                </div>

                <div class="nv2-index-list">
                    {isLoading ? (
                        <div class="nv2-loading-placeholder">
                            <span class="nv2-spinner"></span> Loading indices...
                        </div>
                    ) : indices.length === 0 ? (
                        <div class="nv2-empty-state-small">No indices found on disk.</div>
                    ) : (
                        indices.map(idx => {
                            const isCompatible = idx.dimension === currentSystemDim;
                            const isActive = kernel.settings.indexing.activeIndexPath === idx.path;

                            return (
                                <div key={idx.path} class={`nv2-index-item ${!isCompatible ? 'nv2-index-item--incompatible' : ''} ${isActive ? 'nv2-index-item--active' : ''}`}>
                                    <div class="nv2-index-info">
                                        <div class="nv2-index-name-row">
                                            <span class="nv2-index-name">{idx.displayName}</span>
                                            {idx.source === "vault" && <span class="nv2-badge nv2-badge--subtle">External</span>}
                                            {isActive && <span class="nv2-badge nv2-badge--active">Active</span>}
                                        </div>
                                        <div class="nv2-index-meta">
                                            {idx.dimension}d • {idx.docCount} docs • {formatDate(idx.createdAt)}
                                        </div>
                                    </div>

                                    {!isActive && (
                                        <button
                                            class="nv2-btn nv2-btn-sm"
                                            disabled={!isCompatible}
                                            onClick={() => handleSwitchIndex(idx.path)}
                                            title={!isCompatible ? `Dimension mismatch: Index is ${idx.dimension}d, System is ${currentSystemDim}d` : "Load this index"}
                                        >
                                            {isCompatible ? "Load" : "Incompatible"}
                                        </button>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </BaseModal>
    );
}

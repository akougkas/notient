/**
 * Simple Vault Vitals
 *
 * Computes health metrics for the vault.
 * Works with the simplified IndexManager.
 */

import type { Kernel } from "../kernel";
import type { EventBus } from "../events/eventBus";
import type { VectorStore } from "../../services/vectorStore";
import type { IndexManager } from "../../services/indexManager";
import { ParaDetector } from "../para/detector";
import type {
  VaultVitalsData,
  VaultCounts,
  ConnectivityMetrics,
  ProcessingStatus,
  ParaDistribution,
  HealthScore,
} from "../../types/vitals";

/**
 * Vault vitals calculator (simplified version)
 */
export class SimpleVaultVitals {
  private paraDetector: ParaDetector;
  private disposed = false;
  private lastVitals: VaultVitalsData | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    _vectorStore: VectorStore,
    private indexManager: IndexManager
  ) {
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  /**
   * Compute vault vitals
   */
  async compute(): Promise<VaultVitalsData> {
    if (this.disposed) {
      throw new Error("VaultVitals is disposed");
    }

    const files = this.kernel.obsidian.getMarkdownFiles();

    const counts = await this.computeCounts(files);
    const connectivity = await this.computeConnectivity(files);
    const processing = await this.computeProcessingStatus();
    const paraDistribution = this.computeParaDistribution(files);

    const vitals: VaultVitalsData = {
      computedAt: Date.now(),
      counts,
      connectivity,
      processing,
      paraDistribution,
    };

    this.lastVitals = vitals;
    this.eventBus.emit("vitals:updated", { vitals });

    return vitals;
  }

  /**
   * Get cached vitals if available
   */
  getCached(): VaultVitalsData | null {
    return this.lastVitals;
  }

  /**
   * Compute basic counts
   */
  private async computeCounts(files: { path: string }[]): Promise<VaultCounts> {
    let orphanCount = 0;
    let hubCount = 0;
    let inboxSize = 0;
    let totalLinks = 0;

    const allTags = new Set<string>();

    for (const file of files) {
      const metadata = this.kernel.obsidian.getMetadataByPath(file.path);

      // Count links
      const links = metadata?.links ?? [];
      totalLinks += links.length;

      // Orphan detection (no outgoing links)
      if (links.length === 0) {
        orphanCount++;
      }

      // Hub detection (5+ links)
      if (links.length >= 5) {
        hubCount++;
      }

      // Tags
      const tags = metadata?.tags ?? [];
      for (const tag of tags) {
        allTags.add(tag);
      }

      // Inbox size
      if (this.paraDetector.detectType(file.path) === "inbox") {
        inboxSize++;
      }
    }

    return {
      totalNotes: files.length,
      inboxSize,
      orphanCount,
      hubCount,
      totalTags: allTags.size,
      totalLinks,
    };
  }

  /**
   * Compute connectivity metrics
   */
  private async computeConnectivity(
    files: { path: string }[]
  ): Promise<ConnectivityMetrics> {
    const incomingLinks: Map<string, number> = new Map();
    const outgoingLinks: Map<string, number> = new Map();

    // Initialize counts
    for (const file of files) {
      incomingLinks.set(file.path, 0);
      outgoingLinks.set(file.path, 0);
    }

    // Count links
    for (const file of files) {
      const metadata = this.kernel.obsidian.getMetadataByPath(file.path);
      const links = metadata?.links ?? [];

      outgoingLinks.set(file.path, links.length);

      for (const link of links) {
        const linkedPath = this.resolveLink(link, files);
        if (linkedPath) {
          incomingLinks.set(
            linkedPath,
            (incomingLinks.get(linkedPath) ?? 0) + 1
          );
        }
      }
    }

    // Calculate metrics
    let totalLinks = 0;
    let noIncoming = 0;
    let noOutgoing = 0;

    for (const file of files) {
      const incoming = incomingLinks.get(file.path) ?? 0;
      const outgoing = outgoingLinks.get(file.path) ?? 0;

      totalLinks += outgoing;
      if (incoming === 0) noIncoming++;
      if (outgoing === 0) noOutgoing++;
    }

    const averageLinksPerNote =
      files.length > 0 ? totalLinks / files.length : 0;

    // Find top connected notes
    const combined: { path: string; count: number }[] = files.map((f) => ({
      path: f.path,
      count:
        (incomingLinks.get(f.path) ?? 0) + (outgoingLinks.get(f.path) ?? 0),
    }));

    combined.sort((a, b) => b.count - a.count);

    const topConnectedNotes = combined.slice(0, 5).map((n) => {
      const file = this.kernel.obsidian.getFileByPath(n.path);
      return {
        path: n.path,
        title: file?.basename ?? n.path,
        linkCount: n.count,
      };
    });

    return {
      averageLinksPerNote: Math.round(averageLinksPerNote * 10) / 10,
      noIncomingLinks: noIncoming,
      noOutgoingLinks: noOutgoing,
      topConnectedNotes,
    };
  }

  /**
   * Resolve a link to a file path
   */
  private resolveLink(link: string, files: { path: string }[]): string | null {
    const normalized = link.replace(/\.md$/, "").toLowerCase();

    for (const file of files) {
      const filePath = file.path.toLowerCase();
      const fileBase = filePath.replace(/\.md$/, "");

      if (fileBase === normalized || fileBase.endsWith("/" + normalized)) {
        return file.path;
      }
    }

    return null;
  }

  /**
   * Compute processing status from IndexManager
   */
  private async computeProcessingStatus(): Promise<ProcessingStatus> {
    const totalFiles = this.kernel.obsidian.getMarkdownFiles().length;
    const indexedCount = this.indexManager.getIndexedCount();
    const lastFullIndex = this.indexManager.getLastFullIndexAt();

    const pendingCount = Math.max(0, totalFiles - indexedCount);
    const freshness =
      totalFiles > 0 ? Math.round((indexedCount / totalFiles) * 100) : 0;

    return {
      indexedCount,
      pendingCount,
      errorCount: 0,
      lastFullIndexAt: lastFullIndex,
      freshness,
    };
  }

  /**
   * Compute PARA distribution
   */
  private computeParaDistribution(
    files: { path: string }[]
  ): ParaDistribution {
    const distribution: ParaDistribution = {
      inbox: 0,
      projects: 0,
      areas: 0,
      resources: 0,
      archive: 0,
      unknown: 0,
    };

    for (const file of files) {
      const type = this.paraDetector.detectType(file.path);
      distribution[type]++;
    }

    return distribution;
  }

  /**
   * Calculate health score
   */
  calculateHealthScore(vitals: VaultVitalsData): HealthScore {
    // Connectivity score (0-100)
    const avgLinksScore = Math.min(
      vitals.connectivity.averageLinksPerNote * 20,
      100
    );
    const orphanPenalty =
      vitals.counts.totalNotes > 0
        ? (vitals.counts.orphanCount / vitals.counts.totalNotes) * 50
        : 0;
    const connectivity = Math.max(avgLinksScore - orphanPenalty, 0);

    // Freshness score (already 0-100)
    const freshness = vitals.processing.freshness;

    // Organization score
    const unknownRatio =
      vitals.counts.totalNotes > 0
        ? vitals.paraDistribution.unknown / vitals.counts.totalNotes
        : 0;
    const organization = Math.max((1 - unknownRatio) * 100, 0);

    // Processing score
    const errorRatio =
      vitals.counts.totalNotes > 0
        ? vitals.processing.errorCount / vitals.counts.totalNotes
        : 0;
    const processing = Math.max((1 - errorRatio) * 100, 0);

    // Overall score (weighted average)
    const overall = Math.round(
      connectivity * 0.3 +
        freshness * 0.25 +
        organization * 0.25 +
        processing * 0.2
    );

    return {
      overall,
      connectivity: Math.round(connectivity),
      freshness: Math.round(freshness),
      organization: Math.round(organization),
      processing: Math.round(processing),
    };
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.disposed = true;
    this.lastVitals = null;
  }
}

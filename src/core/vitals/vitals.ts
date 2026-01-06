/**
 * Vault Vitals
 * 
 * Computes health metrics for the vault.
 */

import type { Kernel } from "../kernel";
import type { EventBus } from "../events/eventBus";
import type { VectorStore } from "../../services/vectorStore";
import type { IndexStateStore } from "../indexer/indexState";
import type { JobQueue } from "../queue/jobQueue";
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
 * Vault vitals calculator
 */
export class VaultVitals {
  private paraDetector: ParaDetector;
  private disposed = false;
  private lastVitals: VaultVitalsData | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private vectorStore: VectorStore,
    private indexState: IndexStateStore,
    private jobQueue: JobQueue
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
    const processing = this.computeProcessingStatus();
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
    let totalTags = 0;
    let totalLinks = 0;
    let inboxSize = 0;

    const allTags = new Set<string>();
    const linkCounts: Map<string, number> = new Map();

    for (const file of files) {
      const metadata = this.kernel.obsidian.getMetadataByPath(file.path);
      
      // Count links
      const links = metadata?.links ?? [];
      linkCounts.set(file.path, links.length);
      totalLinks += links.length;

      // Orphan detection
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

      // Count incoming links
      for (const link of links) {
        // Resolve link to path
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
    // Simple resolution - could be improved with Obsidian's link resolution
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
   * Compute processing status from index state
   */
  private computeProcessingStatus(): ProcessingStatus {
    const counts = this.indexState.getCounts();
    const queueStatus = this.jobQueue.getStatus();
    const lastFullIndex = this.indexState.getLastFullIndexAt();

    const total =
      counts.pending + counts.processing + counts.indexed + counts.error;
    const freshness = total > 0 ? (counts.indexed / total) * 100 : 0;

    return {
      indexedCount: counts.indexed,
      pendingCount: counts.pending + counts.processing,
      errorCount: counts.error,
      queueLength: queueStatus.pending + queueStatus.inProgress,
      lastFullIndexAt: lastFullIndex,
      freshness: Math.round(freshness),
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
    // Good: high average links, low orphans
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
    // Good: low unknown, distributed across PARA
    const totalPara =
      vitals.paraDistribution.inbox +
      vitals.paraDistribution.projects +
      vitals.paraDistribution.areas +
      vitals.paraDistribution.resources +
      vitals.paraDistribution.archive;
    const unknownRatio =
      vitals.counts.totalNotes > 0
        ? vitals.paraDistribution.unknown / vitals.counts.totalNotes
        : 0;
    const organization = Math.max((1 - unknownRatio) * 100, 0);

    // Processing score
    // Good: low pending, low errors
    const errorRatio =
      vitals.counts.totalNotes > 0
        ? vitals.processing.errorCount / vitals.counts.totalNotes
        : 0;
    const processing = Math.max((1 - errorRatio) * 100, 0);

    // Overall score (weighted average)
    const overall = Math.round(
      connectivity * 0.3 + freshness * 0.25 + organization * 0.25 + processing * 0.2
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

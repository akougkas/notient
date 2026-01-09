# Coding Session: Identity System Implementation

> **Goal:** Implement the complete identity system for v0.1 as specified in `docs/IDENTITY_AND_PROMPTS.md`

**Session Date:** Next coding session (post-design)
**Duration:** 4-6 hours
**Complexity:** Medium-High (new services + refactor existing prompts)

---

## Pre-Session Checklist

Before starting this session, ensure:
- [ ] Read `docs/IDENTITY_AND_PROMPTS.md` (full spec)
- [ ] Review `planning/coding_tasks/notient-system-prompts.md` (original notes)
- [ ] Current branch is clean (`git status`)
- [ ] Test vault has index built (for inference testing)
- [ ] LM Studio and Ollama are running

---

## Session Roadmap

### Phase 1: Core Infrastructure (1-1.5 hours)

**Objective:** Create base identity layer and profile management service.

#### Task 1.1: Create `src/core/agent/identity.ts`

**What to build:**
```typescript
// src/core/agent/identity.ts

import type { UserProfile } from "@types/profile";

/**
 * Builds the base Research Chief of Staff identity prompt.
 * This is Tier 1 of the two-tier prompt architecture.
 */
export function buildBaseIdentity(profile?: UserProfile): string {
  // Implementation from docs/IDENTITY_AND_PROMPTS.md Example 2
  // Core identity + methodology + user expertise context
}

/**
 * Helper: Format user domain expertise for prompt injection
 */
function buildDomainContext(domain: UserProfile["domain"]): string {
  // See spec for exact format
}

/**
 * Helper: Format PARA folder context for prompt injection
 */
function formatPARAContext(para: UserProfile["para"]): string {
  // See spec for exact format
}

/**
 * Get task-specific overlay (Tier 2 of prompt architecture)
 */
export function getTaskOverlay(taskType: TaskType): string {
  // Return task-specific instructions from spec
  // Cases: "enrich" | "link" | "classify" | "analyze" | "chat"
}
```

**Tests to write:**
- [ ] `buildBaseIdentity(undefined)` returns generic identity (no profile)
- [ ] `buildBaseIdentity(hpcProfile)` includes HPC context
- [ ] `getTaskOverlay("enrich")` returns enrich-specific instructions
- [ ] All task types covered ("enrich", "link", "classify", "analyze", "chat")

#### Task 1.2: Create `src/types/profile.ts`

**What to build:**
```typescript
// src/types/profile.ts

export interface UserProfile {
  version: "1.0";
  domain: {
    primary: string;
    secondary?: string[];
    keywords?: string[];
  };
  para: {
    projects: string[];
    areas: string[];
    resources: string[];
    archives: string[];
  };
  preferences?: {
    citationStyle?: "wikilink" | "markdown";
    formality?: "formal" | "balanced" | "casual";
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type ProfileInferenceStatus =
  | "idle"
  | "checking_index"
  | "clustering"
  | "analyzing"
  | "detecting_para"
  | "complete"
  | "error";
```

#### Task 1.3: Create `src/core/agent/profileManager.ts`

**What to build:**
```typescript
// src/core/agent/profileManager.ts

import type { Kernel } from "@core/kernel";
import type { UserProfile, ValidationResult, ProfileInferenceStatus } from "@types/profile";
import type { Vault } from "obsidian";

export class ProfileManager {
  private profile: UserProfile | undefined;
  private profilePath: string;

  constructor(
    private vault: Vault,
    private kernel: Kernel,
    storagePath: string
  ) {
    this.profilePath = `${storagePath}/profile.json`;
  }

  /**
   * Load profile from disk (or return undefined if not exists)
   */
  async load(): Promise<UserProfile | undefined> {
    // Check if file exists
    // Read JSON
    // Validate schema
    // Cache in this.profile
    // Return profile or undefined
  }

  /**
   * Save profile to disk
   */
  async save(profile: UserProfile): Promise<void> {
    // Validate profile
    // Write to this.profilePath
    // Update cached this.profile
  }

  /**
   * Infer profile from vault embeddings
   * Returns Promise that emits status updates via callback
   */
  async infer(
    onProgress?: (status: ProfileInferenceStatus, message: string) => void
  ): Promise<UserProfile> {
    // Step 1: Check if index exists
    // Step 2: Cluster embeddings (top 5 clusters)
    // Step 3: LLM analysis of clusters → domain detection
    // Step 4: Detect PARA folders heuristically
    // Step 5: Construct and return profile
    // See spec for detailed algorithm
  }

  /**
   * Validate profile structure
   */
  validate(profile: UserProfile): ValidationResult {
    // Check required fields
    // Validate version
    // Check PARA paths exist in vault
    // Return { valid, errors }
  }

  /**
   * Reset to empty profile
   */
  async reset(): Promise<void> {
    // Delete profile.json if exists
    // Clear cached profile
  }

  /**
   * Check if profile exists
   */
  async exists(): Promise<boolean> {
    // Check if this.profilePath file exists
  }

  /**
   * Get current loaded profile (from cache)
   */
  get(): UserProfile | undefined {
    return this.profile;
  }
}
```

**Implementation Notes:**
- Use `kernel.get<IndexManager>("indexManager")` to check index
- Use `kernel.get<SimpleVectorStore>("vectorStore")` for clustering
- Use `kernel.get<LLMProvider>("llmProvider")` for domain analysis
- Error handling: Timeout after 30s, fallback to manual entry
- Clustering algorithm: k-means or simple density-based grouping

**Tests:**
- [ ] `load()` returns undefined if file doesn't exist
- [ ] `save()` writes valid JSON
- [ ] `validate()` catches missing required fields
- [ ] `infer()` throws if index doesn't exist
- [ ] `reset()` clears cached profile

---

### Phase 2: Profile Inference Logic (1-1.5 hours)

**Objective:** Implement embeddings-based domain inference.

#### Task 2.1: Implement clustering in `SimpleVectorStore`

**What to add:**
```typescript
// src/services/simpleVectorStore.ts

/**
 * Cluster embeddings to detect top K themes
 * Returns array of clusters with representative note IDs
 */
async clusterTopK(k: number = 5): Promise<Cluster[]> {
  // Algorithm:
  // 1. Get all note-level embeddings
  // 2. For each embedding, find K nearest neighbors
  // 3. Group notes with high mutual similarity
  // 4. Return top K clusters by density
  // 5. Include representative notes (closest to cluster centroid)
}

interface Cluster {
  id: number;
  representativeNotes: string[]; // Note paths
  density: number; // How tightly clustered
  centroid: number[]; // Average embedding
}
```

**Alternative (simpler):** Just return top 50 most-connected notes and let LLM infer themes.

#### Task 2.2: Implement domain inference LLM call

**What to build:**
```typescript
// In profileManager.ts -> infer()

// Build inference prompt
const clusterTitles = clusters.flatMap(c => c.representativeNotes.map(path => {
  return vault.getAbstractFileByPath(path)?.name || path;
}));

const inferencePrompt = `
Analyze these note titles from a user's Obsidian vault and infer their primary domain of expertise.

NOTE TITLES:
${clusterTitles.map(title => `- ${title}`).join("\n")}

Return JSON with this schema:
{
  "primary": "The main field (e.g., 'High-Performance Computing', 'Law', 'Biology')",
  "secondary": ["Related field 1", "Related field 2"],
  "keywords": ["domain term 1", "domain term 2", "domain term 3"]
}

Be specific. Use professional terminology. Detect the actual domain, not generic categories.
`.trim();

// LLM call
const llm = this.kernel.get<LLMProvider>("llmProvider");
const response = await llm.complete([
  { role: "system", content: "You are a domain inference specialist. You detect user expertise from note collections." },
  { role: "user", content: inferencePrompt }
]);

// Parse JSON
const inferred = JSON.parse(response) as {
  primary: string;
  secondary: string[];
  keywords: string[];
};
```

#### Task 2.3: Implement PARA folder detection

**What to build:**
```typescript
// In profileManager.ts -> infer()

async function detectPARAFolders(vault: Vault): Promise<UserProfile["para"]> {
  const allFolders = vault.getAllLoadedFiles()
    .filter(f => f instanceof TFolder)
    .map(f => f.path);

  const para = {
    projects: [] as string[],
    areas: [] as string[],
    resources: [] as string[],
    archives: [] as string[],
  };

  // Heuristics:
  // - Folders starting with "10", "Project", "Projects"
  // - Folders starting with "20", "Area", "Areas"
  // - Folders starting with "30", "Resource", "Resources"
  // - Folders starting with "40", "Archive", "Archives"

  for (const folder of allFolders) {
    const lowerPath = folder.toLowerCase();

    if (lowerPath.match(/^(10|project)/)) {
      para.projects.push(folder);
    } else if (lowerPath.match(/^(20|area)/)) {
      para.areas.push(folder);
    } else if (lowerPath.match(/^(30|resource)/)) {
      para.resources.push(folder);
    } else if (lowerPath.match(/^(40|archive)/)) {
      para.archives.push(folder);
    }
  }

  return para;
}
```

**Tests:**
- [ ] Detects "10 Projects/" → projects
- [ ] Detects "Projects/" → projects
- [ ] Detects "Archive/" → archives
- [ ] Returns empty arrays if no PARA structure found

---

### Phase 3: Two-Tier Prompt Refactor (1.5-2 hours)

**Objective:** Refactor existing prompts to use base identity + overlays.

#### Task 3.1: Refactor `promptBuilder.ts`

**What to change:**
```typescript
// src/core/agent/promptBuilder.ts

import { buildBaseIdentity, getTaskOverlay } from "./identity";
import type { UserProfile } from "@types/profile";

export class NotientPromptBuilder {
  constructor(
    private kernel: Kernel,
    private profile?: UserProfile  // NEW: inject profile
  ) {}

  /**
   * Build system prompt using two-tier architecture
   */
  buildSystemPrompt(params: PromptParams): string {
    // Tier 1: Base identity
    const baseIdentity = buildBaseIdentity(this.profile);

    // Tier 2: Task overlay (if task type specified)
    const taskOverlay = params.taskType
      ? getTaskOverlay(params.taskType)
      : "";

    // Compose full prompt
    return `
${baseIdentity}

${taskOverlay}

${params.currentNote ? formatCurrentNote(params.currentNote) : ""}

${params.relatedNotes?.length ? formatRelatedNotes(params.relatedNotes) : ""}

${params.contextSummary ? `\nVAULT CONTEXT:\n${params.contextSummary}` : ""}
`.trim();
  }

  // Keep existing methods:
  // - buildActionPlanPrompt() - may need profile injection too
  // - formatCurrentNote()
  // - formatRelatedNotes()
}
```

**What to update:**
- Remove hardcoded `BASE_SYSTEM_PROMPT` constant
- Inject profile via constructor
- Use `buildBaseIdentity(profile)` instead

#### Task 3.2: Update `agentLoop.ts` to pass profile

**What to change:**
```typescript
// src/core/agent/agentLoop.ts

// In constructor, load profile
constructor(/* ... */) {
  // ...existing code...

  // Load profile from ProfileManager
  const profileManager = this.kernel.get<ProfileManager>("profileManager");
  const profile = await profileManager.load();  // May be undefined

  this.promptBuilder = new NotientPromptBuilder(this.kernel, profile);
}
```

#### Task 3.3: Refactor Intelligence 2.0 prompts

**Files to update:**
- `src/core/intelligence/prompts/atomic.ts`
- `src/core/intelligence/prompts/synthesis.ts`
- `src/core/intelligence/prompts/clipping.ts`
- `src/core/intelligence/prompts/task.ts`
- `src/core/intelligence/prompts/brand.ts`
- `src/core/intelligence/prompts/connection.ts`
- `src/core/intelligence/prompts/enhance.ts`

**Pattern (example for atomic.ts):**
```typescript
// BEFORE:
const ATOMIC_SPLIT_PROMPT = `
You are a knowledge architect specializing in breaking down complex technical content.

CONTEXT:
User researches HPC, AI/ML, distributed systems. // ⚠️ Hardcoded!
...
`;

// AFTER:
import { buildBaseIdentity } from "@core/agent/identity";
import type { UserProfile } from "@types/profile";

export function buildAtomicSplitPrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);

  return `
${baseIdentity}

SPECIALIZED ROLE: Knowledge Architect
You excel at breaking down complex technical content into atomic concepts.

ATOMIC CONCEPT CRITERIA:
- Self-contained (100-300 words)
- Single idea or technique
...
`.trim();
}
```

**Repeat for all 7 prompts.**

#### Task 3.4: Update `actionOrchestrator.ts` to use new prompts

**What to change:**
```typescript
// src/core/intelligence/actionOrchestrator.ts

import { buildAtomicSplitPrompt } from "./prompts/atomic";
// ... import other prompt builders

// In execute() methods, pass profile:
const profileManager = this.kernel.get<ProfileManager>("profileManager");
const profile = await profileManager.load();

const prompt = buildAtomicSplitPrompt(profile);
```

---

### Phase 4: Settings UI (1-1.5 hours)

**Objective:** Add Identity section to Settings tab.

#### Task 4.1: Add Identity section to `settings.ts`

**What to build:**
```typescript
// src/settings.ts

// Add new setting section
containerEl.createEl("h2", { text: "Identity" });

// Description
containerEl.createEl("p", {
  text: "Configure Notient's persona and domain expertise. Profile influences prompts silently (no UI badges).",
  cls: "setting-item-description"
});

// Generate from Vault button
new Setting(containerEl)
  .setName("Profile")
  .setDesc("Generate domain profile from vault embeddings, or edit manually.")
  .addButton(button => button
    .setButtonText("Generate from Vault")
    .onClick(async () => {
      // Show loading state
      button.setDisabled(true);
      button.setButtonText("Analyzing vault...");

      try {
        const profileManager = this.plugin.kernel.get<ProfileManager>("profileManager");

        // Run inference with progress callback
        const profile = await profileManager.infer((status, message) => {
          button.setButtonText(message);
        });

        // Show preview modal
        new ProfilePreviewModal(this.app, profile, async (editedProfile) => {
          await profileManager.save(editedProfile);
          new Notice("Profile saved successfully");
          this.display(); // Refresh settings
        }).open();

      } catch (error) {
        new Notice(`Profile generation failed: ${error.message}`);
      } finally {
        button.setDisabled(false);
        button.setButtonText("Generate from Vault");
      }
    })
  );

// Manual edit fields (show current profile if exists)
const profileManager = this.plugin.kernel.get<ProfileManager>("profileManager");
const currentProfile = await profileManager.load();

new Setting(containerEl)
  .setName("Primary Domain")
  .setDesc("Your main field of expertise (e.g., 'High-Performance Computing', 'Law', 'Biology')")
  .addText(text => text
    .setPlaceholder("Enter primary domain")
    .setValue(currentProfile?.domain.primary || "")
    .onChange(async (value) => {
      // Auto-save on change
      const profile = currentProfile || createEmptyProfile();
      profile.domain.primary = value;
      await profileManager.save(profile);
    })
  );

// Add similar settings for:
// - Secondary domains (comma-separated)
// - Keywords (comma-separated)
// - PARA folders (4 text inputs)

// Reset button
new Setting(containerEl)
  .setName("Reset Profile")
  .setDesc("Clear all profile data and use generic Notient identity.")
  .addButton(button => button
    .setButtonText("Reset")
    .setWarning()
    .onClick(async () => {
      if (confirm("Are you sure? This will delete your profile.")) {
        await profileManager.reset();
        new Notice("Profile reset");
        this.display(); // Refresh settings
      }
    })
  );
```

#### Task 4.2: Create `ProfilePreviewModal`

**What to build:**
```typescript
// src/views/profilePreviewModal.ts

import { Modal, App, Setting } from "obsidian";
import type { UserProfile } from "@types/profile";

export class ProfilePreviewModal extends Modal {
  constructor(
    app: App,
    private profile: UserProfile,
    private onConfirm: (profile: UserProfile) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Review Inferred Profile" });

    contentEl.createEl("p", {
      text: "Notient analyzed your vault and detected the following. Edit if needed, then click Save."
    });

    // Show inferred data with editable fields
    // Primary domain, secondary domains, keywords
    // PARA folders (read-only, detected automatically)

    // Buttons: Save | Cancel
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

    buttonContainer.createEl("button", { text: "Save", cls: "mod-cta" })
      .addEventListener("click", async () => {
        await this.onConfirm(this.profile);
        this.close();
      });

    buttonContainer.createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
```

---

### Phase 5: Command Palette Integration (30 minutes)

**Objective:** Add commands for profile management.

#### Task 5.1: Add commands in `main.ts`

**What to add:**
```typescript
// src/main.ts

// In onload()
this.addCommand({
  id: "generate-profile",
  name: "Generate Profile from Vault",
  callback: async () => {
    try {
      const profileManager = this.kernel.get<ProfileManager>("profileManager");

      // Check if index exists
      const indexManager = this.kernel.get<IndexManager>("indexManager");
      if (!indexManager.hasIndex()) {
        new Notice("Please build index first (Settings > Index > Rebuild)");
        return;
      }

      // Show progress notice
      const notice = new Notice("Analyzing vault...", 0); // 0 = don't auto-dismiss

      const profile = await profileManager.infer((status, message) => {
        notice.setMessage(message);
      });

      notice.hide();

      // Show preview modal
      new ProfilePreviewModal(this.app, profile, async (editedProfile) => {
        await profileManager.save(editedProfile);
        new Notice("Profile saved successfully");
      }).open();

    } catch (error) {
      new Notice(`Profile generation failed: ${error.message}`);
    }
  }
});

this.addCommand({
  id: "edit-profile",
  name: "Edit Profile",
  callback: () => {
    // Open Settings > Identity tab
    // (Obsidian API for this: app.setting.open() and scroll to Identity section)
    this.app.setting.open();
    // TODO: Scroll to Identity section programmatically
  }
});
```

---

### Phase 6: Kernel Integration & Testing (1 hour)

**Objective:** Wire ProfileManager into Kernel and test end-to-end.

#### Task 6.1: Register ProfileManager in Kernel

**What to add:**
```typescript
// src/core/kernel.ts

import { ProfileManager } from "@core/agent/profileManager";

// In initialize() or service registration section
const profileManager = new ProfileManager(
  this.vault,
  this,
  storagePaths.pluginDataDir
);

await profileManager.load(); // Load profile on startup

this.register("profileManager", profileManager);
```

#### Task 6.2: Update service initialization order

**Ensure:**
- ProfileManager loads BEFORE NotientAgent (agent needs profile for prompts)
- ProfileManager loads AFTER vault is available

#### Task 6.3: End-to-End Tests

**Test scenarios:**

1. **Fresh Install (No Profile)**
   - [ ] Settings > Identity shows empty fields
   - [ ] "Generate from Vault" button exists
   - [ ] Agent prompts use generic base identity (no domain context)

2. **Profile Generation**
   - [ ] Click "Generate from Vault"
   - [ ] Index exists check works (shows notice if missing)
   - [ ] Progress updates appear ("Clustering...", "Analyzing...")
   - [ ] Preview modal shows inferred profile
   - [ ] Edit fields are pre-filled
   - [ ] Save button persists to `.obsidian/plugins/notient/profile.json`

3. **Profile Usage**
   - [ ] After saving profile, trigger Quick Action "Enhance"
   - [ ] Check agent streaming response includes domain-appropriate terminology
   - [ ] Verify system prompt includes "USER EXPERTISE CONTEXT" section
   - [ ] Test with different domains (HPC, Law, Biology) → responses adapt

4. **Manual Profile Edit**
   - [ ] Settings > Identity > Edit "Primary Domain" field
   - [ ] Changes auto-save
   - [ ] Reload plugin → changes persist
   - [ ] Agent uses updated profile

5. **Profile Reset**
   - [ ] Click "Reset Profile"
   - [ ] Confirmation dialog appears
   - [ ] After confirm, profile.json deleted
   - [ ] Settings shows empty fields
   - [ ] Agent uses generic prompts again

6. **Command Palette**
   - [ ] "Notient: Generate Profile from Vault" works
   - [ ] "Notient: Edit Profile" opens Settings

7. **Error Handling**
   - [ ] Generate profile with no index → Shows error notice
   - [ ] LLM inference timeout (>30s) → Falls back gracefully
   - [ ] Invalid JSON in profile.json → Validation catches error
   - [ ] Missing PARA folders → Empty arrays, no crash

---

## Post-Session Checklist

After completing all phases:
- [ ] Run `bun run typecheck` (must pass)
- [ ] Run `bun run lint` (warnings OK, no errors)
- [ ] Run `bun run build` (successful build)
- [ ] Test in Obsidian (all 7 test scenarios above)
- [ ] Commit changes with message: `feat: implement identity system (profile management + two-tier prompts)`
- [ ] Update CHANGELOG.md with new features
- [ ] Update version in manifest.json (0.1.0 → 0.1.1 or similar)

---

## Success Criteria

This session is successful if:
1. ✅ ProfileManager service works (load, save, infer, reset)
2. ✅ Two-tier prompt architecture implemented (base + overlays)
3. ✅ All 7 Intelligence prompts refactored to be profile-aware
4. ✅ Settings > Identity UI functional (generate, edit, preview, reset)
5. ✅ Command Palette commands work
6. ✅ Embeddings-based inference detects correct domain (tested with sample vaults)
7. ✅ Silent integration: Profile influences prompts without UI badges
8. ✅ No regressions: Existing features (search, chat, workflows) still work
9. ✅ All 7 end-to-end test scenarios pass

---

## Known Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Inference is slow (>30s)** | Poor UX | Add timeout, fallback to manual entry |
| **Inference is inaccurate** | Wrong domain detected | Always show preview modal, allow manual edit |
| **Profile breaks existing prompts** | Features stop working | Ensure `profile` is optional everywhere (works without profile) |
| **Clustering algorithm is complex** | Implementation takes too long | Use simpler approach: top 50 most-connected notes instead of clustering |
| **LLM inference fails** | Can't generate profile | Catch error, show notice, allow manual entry as fallback |

---

## Next Session After This

After identity system is implemented, focus on:
- [ ] Measure action acceptance rate baseline (add tracking)
- [ ] Refine prompts based on real user testing
- [ ] Add profile badge in UI (optional toggle in Settings)
- [ ] Setup Wizard integration for profile generation
- [ ] Multi-profile support (v0.2 feature)

---

## Claude Prompt for Next Session

When starting the next coding session, use this prompt:

```
Implement the Notient identity system following the specification in docs/IDENTITY_AND_PROMPTS.md and the implementation plan in planning/coding_tasks/NEXT_SESSION_IDENTITY_IMPLEMENTATION.md.

Work through the 6 phases sequentially:
1. Core infrastructure (identity.ts, profile.ts, profileManager.ts)
2. Profile inference logic (embeddings clustering + LLM analysis)
3. Two-tier prompt refactor (promptBuilder.ts + all 7 Intelligence prompts)
4. Settings UI (Identity section + ProfilePreviewModal)
5. Command Palette integration
6. Kernel integration + end-to-end testing

Follow the detailed task breakdowns in the implementation plan. Run tests after each phase.

Reference files:
- Spec: docs/IDENTITY_AND_PROMPTS.md
- Plan: planning/coding_tasks/NEXT_SESSION_IDENTITY_IMPLEMENTATION.md
- Original notes: planning/coding_tasks/notient-system-prompts.md

Success criteria: All 7 end-to-end test scenarios pass + no regressions.
```

---

**Document Version:** 1.0
**Last Updated:** 2026-01-08
**Author:** Anthony Kougkas (with Claude Opus 4.5)
**Estimated Implementation Time:** 4-6 hours

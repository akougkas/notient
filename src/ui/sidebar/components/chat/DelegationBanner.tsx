/**
 * Delegation Banner
 *
 * Visual indicator shown when chat delegates to a specialist agent.
 * Displays agent name, workflow (if applicable), and progress.
 */

import { Icon } from "../Icon";

interface DelegationBannerProps {
  agent: string;
  workflow?: string;
  progress?: number;
}

const AGENT_LABELS: Record<string, string> = {
  worker: "Workflow Agent",
  "note-editor": "Note Editor",
  "context-builder": "Context Builder",
  orchestrator: "Orchestrator",
  classifier: "Classifier",
  connection: "Connection Agent",
};

const AGENT_ICONS: Record<string, string> = {
  worker: "workflow",
  "note-editor": "pencil",
  "context-builder": "search",
  orchestrator: "brain",
  classifier: "tag",
  connection: "link",
};

export function DelegationBanner({ agent, workflow, progress }: DelegationBannerProps) {
  const agentLabel = AGENT_LABELS[agent] || agent;
  const agentIcon = AGENT_ICONS[agent] || "git-branch";

  return (
    <output class="nv2-delegation-banner" aria-live="polite">
      <div class="nv2-delegation-icon">
        <Icon name={agentIcon} />
      </div>
      <div class="nv2-delegation-info">
        <span class="nv2-delegation-label">
          {workflow ? `Running /${workflow}` : `Delegating to ${agentLabel}`}
        </span>
        {progress !== undefined && (
          <div class="nv2-delegation-progress" aria-label={`Progress: ${progress}%`}>
            <div class="nv2-delegation-progress-bar" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
    </output>
  );
}

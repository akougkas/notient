/**
 * Shared Icon component for rendering Obsidian/Lucide icons in Preact
 *
 * Wraps Obsidian's setIcon() to work with Preact's ref system.
 * Used across all sidebar components for consistent icon rendering.
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

interface IconProps {
  /** Lucide icon name (e.g., "file-text", "brain", "check") */
  name: string;
  /** Optional CSS class for styling */
  className?: string;
}

export function Icon({ name, className }: IconProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, name);
    }
  }, [name]);

  return <span ref={iconRef} class={className} aria-hidden="true" />;
}

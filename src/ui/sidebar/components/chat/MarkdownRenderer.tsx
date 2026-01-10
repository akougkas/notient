/**
 * Markdown Renderer
 *
 * Renders markdown content with syntax highlighting.
 * Uses marked for parsing and Prism.js for code highlighting.
 */

import { marked } from "marked";
import { useEffect, useMemo, useRef } from "preact/hooks";
import Prism from "prismjs";

// Import common language syntaxes
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";

interface MarkdownRendererProps {
  content: string;
  onLinkClick?: (path: string) => void;
  className?: string;
}

/**
 * Configure marked with custom renderer
 */
function createMarkedRenderer(onLinkClick?: (path: string) => void) {
  const renderer = new marked.Renderer();

  // Custom code block rendering with Prism
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const language = lang && Prism.languages[lang] ? lang : "plaintext";
    let highlighted: string;

    try {
      if (Prism.languages[language]) {
        highlighted = Prism.highlight(text, Prism.languages[language], language);
      } else {
        highlighted = escapeHtml(text);
      }
    } catch {
      highlighted = escapeHtml(text);
    }

    return `<pre class="nv2-code-block language-${language}"><code class="language-${language}">${highlighted}</code></pre>`;
  };

  // Custom inline code
  renderer.codespan = ({ text }: { text: string }) => {
    return `<code class="nv2-inline-code">${escapeHtml(text)}</code>`;
  };

  // Custom link handling for wiki-links and external links
  renderer.link = ({ href, text }: { href: string; text: string }) => {
    // Check if it's a wiki-link (internal note reference)
    if (href.startsWith("[[") && href.endsWith("]]")) {
      const notePath = href.slice(2, -2);
      return `<button type="button" class="nv2-internal-link" data-path="${escapeHtml(notePath)}">${escapeHtml(text)}</button>`;
    }

    // External link
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="nv2-external-link">${escapeHtml(text)}</a>`;
  };

  return renderer;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Pre-process content to handle wiki-links before markdown parsing
 */
function preprocessWikiLinks(content: string): string {
  // Convert [[Note Name]] to markdown links that our renderer can handle
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, notePath, displayText) => {
    const text = displayText || notePath;
    return `[${text}]([[${notePath}]])`;
  });
}

export function MarkdownRenderer({ content, onLinkClick, className }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse markdown to HTML
  const html = useMemo(() => {
    const renderer = createMarkedRenderer(onLinkClick);
    const preprocessed = preprocessWikiLinks(content);

    marked.setOptions({
      renderer,
      gfm: true,
      breaks: true,
    });

    return marked.parse(preprocessed) as string;
  }, [content, onLinkClick]);

  // Attach click handlers to wiki-links after render
  useEffect(() => {
    if (!containerRef.current || !onLinkClick) return;

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("nv2-internal-link")) {
        e.preventDefault();
        e.stopPropagation();
        const path = target.getAttribute("data-path");
        if (path) {
          onLinkClick(path);
        }
      }
    };

    containerRef.current.addEventListener("click", handleClick);
    return () => {
      containerRef.current?.removeEventListener("click", handleClick);
    };
  }, [onLinkClick, html]);

  return (
    <div
      ref={containerRef}
      class={`nv2-markdown-content ${className || ""}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Render markdown content to string (for non-interactive use)
 */
export function renderMarkdownToString(content: string): string {
  const preprocessed = preprocessWikiLinks(content);
  const renderer = createMarkedRenderer();

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: true,
  });

  return marked.parse(preprocessed) as string;
}

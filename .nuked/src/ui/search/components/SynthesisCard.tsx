import type { VNode } from "preact";
import { searchActions, searchSynthesis } from "../state";

function renderBodyWithCitations(text: string): Array<string | VNode> {
  const segments: Array<string | VNode> = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let cursor = pattern.exec(text);
  while (cursor !== null) {
    if (cursor.index > lastIndex) {
      segments.push(text.slice(lastIndex, cursor.index));
    }
    const inner = cursor[1] ?? "";
    const target = inner.split("|")[0]?.trim() ?? inner;
    const label = (inner.split("|")[1] ?? inner).trim();
    segments.push(
      <a
        key={`cite-${cursor.index}-${target}`}
        class="notient-cite"
        href={`#${target}`}
        data-target={target}
        onClick={(clickEvent) => {
          clickEvent.preventDefault();
          searchActions.value?.openLink(`[[${target}]]`);
        }}
      >
        [[{label}]]
      </a>,
    );
    lastIndex = cursor.index + cursor[0].length;
    cursor = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }
  return segments;
}

export function SynthesisCard() {
  const card = searchSynthesis.value;
  if (!card) return null;
  return (
    <section class="notient-synthesis notient-synthesis-card" aria-label="Synthesis">
      <header class="notient-synthesis-card__head">
        <h2 class="notient-synthesis__title notient-synthesis-card__title">Synthesis</h2>
        <div class="notient-synthesis-card__actions">
          <button
            type="button"
            class="notient-button notient-synthesis-card__action"
            data-emphasis="ghost"
            onClick={() => searchActions.value?.newChatFromResults()}
          >
            Refine in chat
          </button>
          <button
            type="button"
            class="notient-button notient-synthesis-card__action"
            data-emphasis="ghost"
            onClick={() => searchActions.value?.saveQuery()}
          >
            Save as note
          </button>
        </div>
      </header>
      {card.error ? (
        <p class="notient-synthesis-card__error">{card.error}</p>
      ) : (
        <div class="notient-synthesis__body notient-synthesis-card__body">
          <ul class="notient-synthesis-card__bullets">
            {card.bullets.map((bullet, bulletIndex) => (
              <li key={`bullet-${String(bulletIndex)}`} class="notient-synthesis-card__bullet">
                <p class="notient-synthesis-card__text">{renderBodyWithCitations(bullet.text)}</p>
                {bullet.citations.length > 0 ? (
                  <span class="notient-synthesis-card__citations">
                    {bullet.citations.map((wikilink) => {
                      const inner = wikilink.replace(/^\[\[|\]\]$/g, "");
                      const target = inner.split("|")[0]?.trim() ?? inner;
                      return (
                        <a
                          key={wikilink}
                          class="notient-cite notient-synthesis-card__citation"
                          href={`#${target}`}
                          data-wikilink={wikilink}
                          onClick={(clickEvent) => {
                            clickEvent.preventDefault();
                            searchActions.value?.openLink(wikilink);
                          }}
                        >
                          {wikilink}
                        </a>
                      );
                    })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

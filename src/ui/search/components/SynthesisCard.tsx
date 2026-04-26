import { searchActions, searchSynthesis } from "../state";

export function SynthesisCard() {
  const card = searchSynthesis.value;
  if (!card) return null;
  return (
    <section class="notient-synthesis-card" aria-label="Synthesis">
      <header class="notient-synthesis-card__head">
        <h3 class="notient-synthesis-card__title">Synthesis</h3>
        <div class="notient-synthesis-card__actions">
          <button
            type="button"
            class="notient-synthesis-card__action"
            onClick={() => searchActions.value?.newChatFromResults()}
          >
            Refine in chat
          </button>
          <button
            type="button"
            class="notient-synthesis-card__action"
            onClick={() => searchActions.value?.saveQuery()}
          >
            Save as note
          </button>
        </div>
      </header>
      {card.error ? (
        <p class="notient-synthesis-card__error">{card.error}</p>
      ) : (
        <ul class="notient-synthesis-card__bullets">
          {card.bullets.map((bullet, index) => (
            <li key={`bullet-${String(index)}`} class="notient-synthesis-card__bullet">
              <span class="notient-synthesis-card__text">{bullet.text}</span>
              {bullet.citations.length > 0 ? (
                <span class="notient-synthesis-card__citations">
                  {bullet.citations.map((wikilink) => (
                    <button
                      type="button"
                      key={wikilink}
                      class="notient-synthesis-card__citation"
                      data-wikilink={wikilink}
                      onClick={() => searchActions.value?.openLink(wikilink)}
                    >
                      {wikilink}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

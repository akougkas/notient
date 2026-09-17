/**
 * The one Obsidian tag grammar shared by note structure, the structural
 * index, enrichment validation and storage.
 *
 * A tag name is a run of letters, numbers, combining marks, emoji, `_`, `-`
 * and nested `/` segments, with at least one character that is not a
 * number. Names do not start with `-` or `/`, and nested segments are never
 * empty. Inline tags start at the beginning of text or after whitespace, so
 * URL fragments and `word#text` are not tags. Obsidian treats tags
 * case-insensitively; `tagIdentity` is the stored and compared form.
 */

const TAG_CHARACTERS = String.raw`[\p{L}\p{N}\p{M}_/\-\p{Extended_Pictographic}\u{200D}\u{FE0F}]+`;
const TAG_NAME = new RegExp(`^${TAG_CHARACTERS}$`, "u");

/** Matches `(leading)(#)(name)` occurrences; the caller checks escapes. */
export function inlineTagPattern(): RegExp {
  return new RegExp(String.raw`(^|\s)#(${TAG_CHARACTERS})`, "gu");
}

export function isTagName(name: string): boolean {
  return TAG_NAME.test(name) && /\P{N}/u.test(name) && !/^[-/]|\/$|\/\//.test(name);
}

/** An authored tag value, with or without `#`, or null when it is not a tag. */
export function tagName(raw: string): string | null {
  const name = raw.trim().replace(/^#/, "");
  return isTagName(name) ? name : null;
}

export function tagIdentity(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Preserve authored spelling in Markdown and reads; compare Obsidian tag
 * identities case-insensitively. Descendants are opt-in for protective rules,
 * never an implicit expansion of a permission scope. */
export function hasTag(tags: readonly string[], query: string, descendants = false): boolean {
  const wanted = tagIdentity(query.replace(/^#/, ""));
  if (!wanted) return false;
  return tags.some((tag) => {
    const actual = tagIdentity(tag.replace(/^#/, ""));
    return actual === wanted || (descendants && actual.startsWith(`${wanted}/`));
  });
}

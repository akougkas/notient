export function noteFilename(title: string): string {
  const slug = title
    .normalize("NFC")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 100);
  if (!slug || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug))
    throw new Error("model title cannot form a portable note filename");
  return `${slug}.md`;
}

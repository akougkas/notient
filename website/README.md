# notient.org

One static page, `index.html`, with inline styles and no scripts, build step or
analytics. It loads three Google Fonts families and degrades to system serif and
monospace faces without them.

Every claim on the page is tied to the repository: the terminal frame and the
contradiction finding are captured product output on synthetic notes, the palette
is `src/cli/tui/views/theme.ts`, and the release paragraph states that nothing is
published. Update that paragraph and add download links only when the exact
artifacts from `bun run release:prepare` are public.

Preview with `bunx serve website` or by opening the file. Deployment needs the
owner's explicit authorization and has not happened.

# notient.org

One static page, `index.html`, with inline styles and no scripts, build step or
analytics. It loads three Google Fonts families and degrades to system serif and
monospace faces without them.

Every claim on the page is tied to the repository: the terminal frame and the
contradiction finding are captured product output on synthetic notes, the palette
is `src/cli/tui/views/theme.ts`, and the install section links the exact assets of the public v0.1.0 release.

Preview with `bunx serve website` or by opening the file. `.github/workflows/pages.yml`
publishes this directory to GitHub Pages on every push to `main` that touches it.
`CNAME` binds the site to notient.org; `og.png` is a capture of the rendered hero.

# notient.org

Static website for Notient. Contains `index.html` and `404.html` with inline styles, progressive enhancement scripts for mobile navigation and code copying, and no build step or analytics. It loads three Google Fonts families and degrades to system serif and monospace typefaces without them. The page is fully usable with JavaScript disabled.

Every claim on the page is tied to the repository: the terminal frame and the contradiction finding are real captured product output on synthetic notes, the palette is derived from `src/cli/tui/views/theme.ts`, and the install section links the exact assets of the public v0.1.0 release.

Preview locally with `bunx serve website` or by opening `index.html` in a browser. The workflow `.github/workflows/pages.yml` publishes this directory to GitHub Pages on every push to `main` that touches it. `CNAME` binds the site to notient.org. `og.png` is a real headless capture of the rendered hero at 1200x630.

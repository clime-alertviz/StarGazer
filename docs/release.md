# Release 0.4.0

Public repository: [clime-alertviz/StarGazer](https://github.com/clime-alertviz/StarGazer).
Submission tag: [v0.4.0](https://github.com/clime-alertviz/StarGazer/tree/v0.4.0).

The demo is included in the repository: `npm run web:demo` starts the app, and
`docs/showcase.mp4` is the short narrated walkthrough. Public hosting is optional.
The project is MIT licensed; retain [LICENSE](../LICENSE) when publishing.

## Before pushing

```bash
npm test
npm run check
npm run check:submission
git status --short
```

Review the files you intend to publish. `.env`, `private/`, `node_modules/` and
`output/` are ignored. The finished video, captions and poster belong in `docs/`
and should be included. Do not add runtime databases, OAuth downloads or tokens.

## Reproducing the publication steps

After reviewing and committing the prepared files to your public repository:

```bash
git tag -a v0.4.0 -m "StarGazer 0.4.0 — runnable demo and walkthrough"
git push origin HEAD
git push origin v0.4.0
git rev-parse HEAD
```

Share the repository URL and `v0.4.0` tag (or the printed full commit hash).
The package version is already **0.4.0**. The submission tag points to the published commit containing the app, video and
documentation. Use a new version for subsequent releases; do not move this tag.

## Submission links

Use your repository's README as the main entry point. It links to the runnable
demo, video, written tutorial, prompts, traces, Geoapify feedback and license.
The [HTML tutorial](index.html) can also be opened locally or hosted as static
files later; keep its video, poster and caption files beside it.

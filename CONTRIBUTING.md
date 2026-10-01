# Contributing to webready

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/sajjadlabs/webready/issues/new/choose) with your webready version (`webready --version`), your OS and Node version, the command you ran, and what happened. If a particular file fails, attaching it (or a similar one) helps most.

## Working on the code

You need Node.js 20 or later.

```bash
git clone https://github.com/sajjadlabs/webready.git
cd webready
npm install
npm test
```

`npm install` also brings the dev dependencies the tests use: `ffmpeg-static` for videos, and React and Vue for the components.

- **No build step.** The source is plain ES modules in `src/`, published as is.
- **`npm test`** runs four suites: `test/pipeline.test.mjs` (the real pipeline, with sharp and ffmpeg), `test/cli.test.mjs` (the command, as a subprocess), `test/components.test.mjs` (React and Vue) and `test/browser.test.mjs` (the browser build, against fake engines). Each can be run on its own: `npm run test:pipeline` and so on.
- **The browser build** can be tried in real browsers with `examples/browser-demo.html` — see the README.
- **Keep changes focused,** and add a test for what you fix or add. If the change is user-facing, add a line to the top of `CHANGELOG.md`.

## Releasing (maintainers)

1. Move the changelog entries under the new version's heading.
2. `npm version patch` (or `minor`, `major`): it updates `package.json`, commits and tags.
3. `git push --follow-tags`, then create a GitHub release from the tag.

The release workflow runs the tests and publishes to npm through trusted publishing — no token involved — and npm attaches provenance. If the version is already on npm, the workflow skips publishing.

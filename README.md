# oauth2api

`oauth2api` is the Limad fork of [AmazingAng/auth2api](https://github.com/AmazingAng/auth2api), an OAuth-to-API proxy exposing OpenAI- and Anthropic-compatible endpoints. It is the shared runtime consumed by the Jeedom plugin [`ai_auth2api`](https://github.com/limad/jeedom_ai_auth2api); the plugin retains ownership of daemon lifecycle, configuration, API key, and OAuth token storage.

Keep the GitHub repository private unless public release is explicitly authorized. This is not an npm package; `package.json` sets `private: true` to prevent accidental publication to npm.

## Upstream and fork policy

- `origin` is `https://github.com/limad/oauth2api.git`.
- `upstream` is `https://github.com/AmazingAng/auth2api.git`.
- Keep the five Jeedom-required changes as reviewable commits on top of an identified upstream commit: Codex refresh handling, Gemini/Copilot providers, provider timers, the optional Ollama facade, and the allowed-IPs middleware.
- The initial fork history is based on upstream commit `a34c011f9fda1013ff3f9299160694c2ab62e4db`, followed by five separate commits for the changes above. Preserve that reviewable history; do not flatten it or apply it to a different upstream revision without first reviewing/rebasing the changes.
- Before each upstream update, review upstream changes and whether each fork commit still applies or has become redundant. Rebase the fork commits onto the chosen upstream commit, resolve conflicts explicitly, run CI, and only then create a new version tag. Do not silently drop a provider or network-security patch.
- Keep upstream protocol/header names (including `x-auth2api-internal`) unchanged unless a compatibility change is deliberate and reviewed.

The Codex `/codex/models` request currently receives `400 Invalid client_version format` from the upstream endpoint. This is recorded as an open fork issue and is deliberately not changed by the phase-2 repository/CI deliverables.

## Model routing and prefixes

`/v1/models` lists the models of every logged-in provider. When two backends serve the
same model name, pick the backend with an explicit prefix:

| Prefix | Backend | Example |
|---|---|---|
| `ag/` | Antigravity (Google Code Assist) | `ag/claude-sonnet-5-5-medium`, `ag/gpt-oss-120b-medium` |
| `at/` | Anthropic (native OAuth) | `at/claude-sonnet-4-6` |
| `cr/` | Cursor | `cr/<model>` |

- Gemini ids work bare (`gemini-3.8-flash-medium`) or as `ag/gemini-...`; every other
  Antigravity model (Claude, gpt-oss) is advertised and routed **only** as `ag/<id>`.
  A bare `claude-*` always goes to the native Anthropic provider.
- The Antigravity catalogue is not hardcoded: it comes from `fetchAvailableModels`, per account
  (plan-dependent), cached 10 min in memory, refreshed hourly and persisted to
  `<auth-dir>/gemini-models.json`. It is empty until the first successful fetch.
- Each Antigravity entry carries `display_name`, `context_length`, `max_completion_tokens`,
  `capabilities` (vision, pdf, audioInput, videoInput, tools, reasoning, ...) and
  `quota: {remaining_fraction, reset_time}` (quota window of that model group).

## Choosing which models are listed

`expose-models` in the config limits what `/v1/models` lists (`*` wildcard, leading `!` excludes,
empty = everything). It only hides models from the list: a request that names a hidden model is
still served. `GET /admin/models` (API key required) returns the full catalogue per provider with an
`exposed` flag per model and the active patterns, so a UI can offer the choice.

```yaml
expose-models:
  - "gemini-3.8-*"
  - "ag/claude-*"
  - "!*-low"
```

A change needs a restart (or a new process) to take effect.

## Node.js requirement

Node.js `>=20` is required (`engines.node` in `package.json`). The executable checks the running major version before loading configuration or starting OAuth/server work and exits with an explicit error on older Node.js versions. The release workflow runs on Node.js 22 and smoke-checks the built executable with a temporary, empty auth directory.

## Development

```bash
npm ci
npm test
npm run build
```

The production bundle is assembled only after `dist/` is built, using `npm ci --omit=dev`. It contains `dist/`, production `node_modules/`, `package.json`, `config.example.yaml`, and this README. The plugin supplies its own persistent config and auth directory at runtime.

## Architecture-independent release

The bundle is `oauth2api-vX.Y.Z.tar.gz` with a matching `oauth2api-vX.Y.Z.tar.gz.sha256` asset. There is no architecture suffix: the current production dependency tree has no native `.node` module. CI rejects `.node` files, `node-gyp`, `binding.gyp`, or `prebuilds/` in production dependencies. If that check ever fails, release must stop until architecture-specific bundles and plugin selection are designed.

Create a `vX.Y.Z` Git tag matching `package.json`'s version after CI passes. The GitHub Actions workflow builds the release archive and attaches both it and its SHA-256 file to the GitHub Release. Verify a downloaded archive with:

```bash
sha256sum -c oauth2api-vX.Y.Z.tar.gz.sha256
```

The Jeedom plugin must pin `OAUTH2API_VERSION` and `OAUTH2API_SHA256` in its own source, not read either value from the downloaded bundle. Phase 3 builds the URL as `oauth2api-v${OAUTH2API_VERSION}.tar.gz`; neither the archive name nor those constants contain an architecture suffix.

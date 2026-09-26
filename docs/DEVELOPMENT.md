# Developing Code Context

Notes for working on the extension itself. For using it, see the
[README](../README.md) and the [user manual](Code_Context_User_Manual.pdf).

The extension started as a spike to put the three context affordances in a real
editor, so they could be argued about with something running rather than in the
abstract. It has no backend: everything is computed locally from the open
workspace and Git.

## Run it

```bash
npm install && npm run compile
```

`compile` type-checks with `tsc` and bundles with esbuild into `dist/extension.js`.

`npm install` also restores `sample/` — a small Python repo with fabricated Git
history (including one commit whose message marks it AI-assisted) — from
`fixtures/sample.bundle`. A repository can't be committed inside another one, so
its history travels as that single bundle file. `npm run sample` restores it on
its own.

Open this folder in VS Code and press **F5**. A second window opens on
`sample/`. Open `billing/invoice.py` and put the cursor inside
`calculate_invoice_total`.

To install it into your everyday editor instead:

```bash
npm run package
```

then **Extensions: Install from VSIX…**. `vsce` is pinned to 2.32.0 in
`devDependencies`: later versions fail on Node 20.17.

## Documents

| | |
|---|---|
| [`docs/Code_Context_User_Manual.pdf`](Code_Context_User_Manual.pdf) | Setup, reading the panel, a worked example, troubleshooting |
| [`docs/Code_Context_Architecture.pdf`](Code_Context_Architecture.pdf) | Principles, components, the index, the pipeline, the AI layer |

Each PDF is printed from the `.html` beside it with headless Chrome.

## The three tiers

| Tier | Surface | What it answers | Why it's this surface |
|---|---|---|---|
| 1 | **CodeLens** above each `def` | "is there anything here?" | The only always-visible, clickable affordance. Hovers can't be clicked into existence. |
| 2 | **Hover** | "do I need to look at this?" | Cheap glance. Text only — see the limits below. |
| 3 | **Webview panel**, opened Beside | "where am I, and what breaks?" | The only surface that can render the interactive map. |

The panel follows the cursor: move to another function and it re-centres,
which is the traversal behaviour the design is built around.

## What a hover can and cannot do

Established while building this, so it doesn't get relitigated:

- `MarkdownString` renders a **sanitized HTML subset** when `supportHtml = true`.
  `style` is allowed on `<span>` only, and only for `color` / `background-color`.
- **Command links** work when `isTrusted = true` — that is the only interactivity.
- Images are allowed from `data:` URIs, but **SVG is broken in hovers**
  ([microsoft/vscode#133389](https://github.com/microsoft/vscode/issues/133389)).
  PNG works. So the map cannot be rendered in a hover without rasterising it,
  which loses theme-awareness — not worth it.
- There is **no API for a floating webview popover** at a text position
  ([microsoft/vscode#175234](https://github.com/microsoft/vscode/issues/175234), open since 2023).

Hence the split: hover = digest, webview = map.

## What is real, and what is faked

**Real**

- Symbol extraction (regex over `def` / `class`, with body ranges)
- Callee extraction from the function body
- Caller resolution across the workspace, with a confidence label:
  `resolved` (defining file, or the file imports the name) vs `heuristic` (name match only)
- Transitive impact — one extra hop, capped
- Test detection by path convention
- Git history via **`git log -L :symbol:file`**, which is genuinely symbol-scoped,
  falling back to `--follow` file history. AI-assisted commits are flagged by
  message pattern.
- Dirty-buffer detection (`git status --porcelain`), surfaced as "buffer ahead of `<sha>`"

**Entry points — the bridge to product language**

Route paths (FastAPI, Flask, including prefixes composed across `include_router`),
Celery tasks, APScheduler jobs, Click/Typer commands, FastAPI events and Django
signals. These propagate: a function with no decorator of its own inherits the
routes of the handlers that reach it, which is how `get_current_admin` becomes
"reached from GET /api/v1/admin/stats".

**The one AI call — opt-in**

`codeContext.ai.enabled` (default **off**) turns on a single call that translates
the deterministic evidence into plain language: a human feature name, what the
code does, how it is reached, and what breaks.

- **Model:** `codeContext.ai.model`, default **`claude-haiku-4-5`**. This is
  translation over a bundle that was already assembled — not a reasoning task —
  so the cheapest model is the right default at roughly $1/$5 per million tokens
  against Opus's $5/$25. Sonnet 5 and Opus 5 are selectable if Haiku's feature
  names read poorly. Note that `output_config.effort` is **rejected by Haiku 4.5**,
  so it is only sent for the models that accept it; changing the model ID alone
  would 400.

- **What leaves the machine when it is on:** the function's source (first 80
  lines), its entry points, caller and callee names with file paths, commit
  subjects, and co-change filenames. Nothing else. Off by default for exactly
  this reason.
- **Provider:** inferred from the model id — `claude-*` uses the Anthropic key,
  `gemini-*` the Google key, `gpt-*` the OpenAI key and `grok-*` the xAI key.
  No second setting to drift out of sync. OpenAI goes through its Responses API
  and xAI through its OpenAI-compatible chat endpoint, both with the official
  `openai` SDK — pinned to 6.49.0, because 7.x requires Node 22 and VS Code 1.90
  runs extensions on Node 20.
- **No key? The editor's own models.** `vscode-lm` uses whatever the editor
  offers extensions through `vscode.lm` — GitHub Copilot's models in VS Code,
  Claude included — with a one-time consent prompt and usage billed to the
  user's Copilot plan. It is also the fallback when the chosen provider has no
  key set, and the panel names the model that actually answered
  (`claude haiku 4.5 via copilot`). Other editors may offer nothing through
  this API; *Code Context: List editor models* reports what yours does.
  Claude Pro/Max and Cursor subscriptions are **not** usable here — neither
  exposes its model access to extensions.
- **Key storage:** the editor's secret storage, via *Code Context: Set API key*
  (it asks which provider). Never settings, never the repo. `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY` and `GOOGLE_API_KEY` work as fallbacks.
- **One schema, both providers:** Anthropic via `jsonSchemaOutputFormat`, Gemini
  via `responseJsonSchema`, and the response is shape-checked either way — neither
  provider is trusted to have obeyed the schema. That is what makes the two
  narrations comparable rather than merely similar.
- **Grounding:** the model is instructed to use only the supplied evidence, to
  cite the evidence ids it relied on, to drop to `low` confidence rather than
  guess, and never to call code unused — absent callers may be a resolution miss.
- **Caching:** by SHA-256 of the evidence bundle, in `globalState`. The same
  symbol never costs twice until its evidence changes. *Clear AI narration cache*
  resets it.
- **Never blocking:** the panel renders deterministic content first and folds the
  narration in when it arrives. Switch the model off and you lose sentences, not facts.

**Still stubbed**

- PR and issue metadata. PR numbers are parsed out of commit subjects rather
  than fetched from a provider.

## What the spike is meant to prove — and what it shows

1. **The map reads faster than the list.** Judge this by opening the panel and
   looking, not by reading the code.
2. **Resolution quality is the real risk.** Open `sample/dynamic_dispatch.py`:
   it calls `calculate_invoice_total` via `getattr`, and the panel does not show
   it as a caller. That is a false negative, in eight files. A real codebase has
   thousands. This is the argument for Jedi or Pyright over regex or raw `ast`.
3. **Confidence has to be visible.** Heuristic edges render dashed and red.
   Delete the `importRe` check in `context.ts` and watch how quickly the panel
   starts lying confidently.
4. **High fan-in breaks the drawing.** Nodes collapse to `+N more` past three,
   with a full list underneath. Try it on a symbol with many callers.

## Files

```
src/lang/types.ts        the LanguagePack interface — everything language-specific
src/lang/index.ts        the installed packs; add a language here
src/lang/python.ts       Python pack (wraps pythonScan, workflow, entryPoints)
src/lang/go.ts           Go pack: func/method/type symbols, package-aware resolution
src/lang/goWorkflow.ts   Go body → steps (err checks fold into the call they guard)
src/lang/goEntryPoints.ts  net/http, Gin, Echo, Chi, Gorilla mux, Fiber, Cobra, cron, gRPC, main
src/lang/goSyntax.ts     masking of strings/comments, import parsing
src/lang/blocks.ts       nesting for the step readers: which loop or condition each step sits in
src/lsp.ts               callers, callees and symbols from the editor's language servers
src/symbols.ts           symbols for any document: pack first, language server otherwise
src/pythonScan.ts        Python symbols and calls by regex
src/workflow.ts          Python body → steps
src/entryPoints.ts       Python routes, tasks, schedules, commands, events, signals
src/repoIndex.ts         the index: build once, persist by commit, update per file
src/context.ts           assembles the ContextResponse — server first, pack rules as fallback
src/git.ts               git log -L with bodies, co-change, changed-since, dirty files
src/ai.ts                evidence bundle, schema, provider routing, validation, cache
src/cache.ts             memoization by document version
src/hover.ts             tier 2
src/codelens.ts          tier 1
src/panel.ts             tier 3 shell + CSP
src/extension.ts         wiring: focus, staleness, commands
media/panel.js           the panel: summary, journey strip, stats, timeline sections, map, stale bar
media/panel.css          themed from --vscode-* tokens so it follows the colour theme
fixtures/                sample.bundle — the demo repo's history
scripts/sample.js        restores sample/ from the bundle
esbuild.js               bundles src/ into dist/extension.js
docs/                    the PDFs and their HTML sources
```

## Two ways to find callers

1. **The language server**, when the editor has one for the file's language: `vscode.executeReferenceProvider`
   for callers (references, so `Depends(fn)` and `r.GET("/x", h.Fn)` count), and the call hierarchy for callees.
   Type-aware, so every edge is marked confirmed. Works for any language.
2. **The index and the pack's rules**, when no server answers within 4 seconds or it returns nothing. Python
   resolves through imports; Go through its package rules. What can't be proved is marked a guess.

The **Code Context** output channel logs which was used for each lookup, and the panel's Detail section
shows it as *Found by*.

## Adding a language

Implement `LanguagePack` from `src/lang/types.ts` and add it to `PACKS` in `src/lang/index.ts`. Nothing in
the panel, Git, staleness or AI code needs to change. The Go pack is the model: symbols and body ranges,
calls, the language's own visibility and import rules for the fallback, a step extractor, and entry points
for its main frameworks. Add an `onLanguage:` activation event in `package.json`.

`ContextResponse` in `src/types.ts` is the API shape from the design doc. Nothing
outside `context.ts` knows the data is local, so pointing this at a real backend
means replacing one function.

<!-- The Marketplace, Open VSX and in-editor page. The repository is private, so nothing here may
     load from GitHub: no images, no links into the repo. GitHub shows .github/README.md instead. -->

<h1 align="center">Code Context Lens</h1>
<p align="center"><b>Know what you're touching.</b></p>

Put your cursor in a Python function you didn't write. Code Context tells you what it does in
plain language, how people and systems reach it, why it was built, and what it's connected to —
in a panel beside your code.

```
get_current_user()                                          ↻
apps/api/app/auth/deps.py · line 42

┃ Admin sign-in                                     Haiku 4.5
┃ Checks the login token on every admin request and loads
┃ the signed-in user, turning away anyone not yet approved.

  ○ GET  /api/v1/admin/stats
  ○ admin_stats()                                     handler
  ● get_current_user()                          this function
    +1 more way in

  4 callers   2 calls   no tests   5 changes   1 AI-assisted

› What it does              7 steps · calls out, reads, can fail
› How it got here                             latest Feb 2026
› What it touches                         map · 6 further out
› Detail                                           2 cautions
```

## Reading the panel

**The summary.** The product area the function belongs to, and one sentence on what it does, in words
anyone on the team can follow. The amber bar on the left means an AI wrote it; the model that answered
is named on the right.

**The journey.** How the outside world gets here: the route or job, the handler it lands in, then this
function. Routes carry a method badge — `GET`, `POST`, `DELETE` — and every row is a click to that code.
It reads your framework's routing: FastAPI, Flask, Celery, APScheduler, Click, Typer and Django signals.
Helpers that nothing reaches from outside simply don't get a journey.

**The numbers.** Callers, calls, tests, changes and AI-assisted commits, in one line. "No tests" is
flagged in red.

Then four sections, collapsed until you want them. Each remembers whether you left it open.

- **What it does** — the function's steps as a timeline, read from its body and put into plain words.
  The dot colours mean *reads or calls*, *changes data*, *can fail* and *returns*, with a key underneath.
  Click a step to jump to that line.
- **How it got here** — why the function was built, from the commit that first introduced it, and how
  that has changed since. When no commit gave a reason, it's marked *inferred*. Below it, the commit
  history as a timeline, with the introducing commit marked *added here* — click any commit to see its diff.
- **What it touches** — a small map: callers above, this function in the middle, what it calls below.
  Click any box to go there. Links the analysis can't prove are drawn dashed.
- **Detail** — what would break if this failed, cautions worth knowing before you change it, whether
  tests reference it, the commit the answer reflects, and which evidence the AI relied on.

Everything outside the amber bars — the journey, the steps' order, callers, commits — is computed
locally from your code and Git, and doesn't depend on a model.

## Getting started

1. Install **Code Context Lens** from the Extensions view (search "Code Context Lens") and open a Python project that uses Git.
2. Click the lens above any function — `3 callers · 5 calls — Show context` — or run
   **Code Context: Show context panel** from the command palette.

That's it for the computed view. Nothing leaves your machine.

### Optional: the plain-language layer

Turn it on in settings:

```json
"codeContext.ai.enabled": true
```

Then give it one way to reach a model:

| Route | Setup | Billed to |
|---|---|---|
| **GitHub Copilot** (VS Code) | Nothing — used automatically when no key is set. Approve the one-time consent prompt. | Your Copilot plan |
| **Anthropic** | **Code Context: Set API key** → Anthropic. Default model `claude-haiku-4-5`. | Your API usage |
| **Google Gemini** | **Code Context: Set API key** → Google, and pick a `gemini-*` model. | Your API usage |

A description typically costs well under a cent on Haiku, and each function is only paid for once
until its code changes. Keys live in the editor's secret storage, never in settings or the repository.

**What is sent when it's on:** for the function you open — its first 80 lines, its routes, caller and
callee names with file paths, commit messages, and co-changed file names. Nothing else, and only to
the provider you chose.

## When the code changes

If you — or Cursor's agent, or Claude Code — edit the function, the panel says
*"This function changed since it was analysed"* and waits. It never re-analyses behind your back,
so an agent writing code in bursts doesn't bill you for descriptions of half-written functions.
Click **Re-analyse** when you're ready.

## Commands

| Command | |
|---|---|
| Show context panel | Open the panel for the function at the cursor |
| Re-analyse this function | Rebuild and ask the AI again |
| Set API key | Store an Anthropic or Google key |
| List editor models | What your editor offers extensions (e.g. Copilot) |
| Clear AI narration cache | Forget saved descriptions |
| Re-index workspace | Rebuild the index from scratch |

## Settings

| Setting | Default | |
|---|---|---|
| `codeContext.ai.enabled` | `false` | The plain-language layer |
| `codeContext.ai.model` | `claude-haiku-4-5` | Also `vscode-lm`, `gemini-3.6-flash`, `claude-sonnet-5`, … |
| `codeContext.ai.editorModel` | | Which editor model to prefer, e.g. `haiku` |
| `codeContext.codeLens` | `true` | Show the lens above functions |
| `codeContext.maxFiles` | `400` | Python files indexed |

## Good to know

- **Python only**, for now.
- **Caller detection reads names, not types.** Calls made through `getattr`, registries or dispatch
  tables can be missed, so the extension never labels code as unused.
- **Claude Pro/Max and Cursor subscriptions can't be used** for the AI layer — neither gives extensions
  access to its models.

## Source code and access

The source repository is private for now. If you'd like access — to read the code, report a bug in
detail, or contribute — ask on the **Q&A** tab of this extension's Visual Studio Marketplace page, and
include your GitHub username.

## License

MIT — the full text ships with the extension.

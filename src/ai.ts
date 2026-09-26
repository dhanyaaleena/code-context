import * as vscode from 'vscode';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { GoogleGenAI } from '@google/genai';
import { ContextResponse, Narration } from './types';

/**
 * The one AI call in the product.
 *
 * Everything it receives was computed deterministically. Its job is translation,
 * not discovery: turn routes, callers and commits into sentences a non-engineer
 * can act on, and cite which evidence each claim came from. It is opt-in,
 * cached by the hash of its evidence, and never blocks the deterministic panel.
 *
 * Two providers are supported so narration quality can be compared at a similar
 * price point. The provider is inferred from the model id, so there is no second
 * setting to drift out of sync with the model.
 */

const SECRETS = {
  anthropic: 'codeContext.anthropicApiKey',
  google: 'codeContext.googleApiKey'
} as const;

type Provider = keyof typeof SECRETS;

const DEFAULT_MODEL = 'claude-haiku-4-5';
/** `output_config.effort` is rejected by Haiku 4.5, so it is sent selectively. */
const EFFORT_MODELS = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']);

function providerOf(model: string): Provider {
  return model.startsWith('gemini') ? 'google' : 'anthropic';
}

function configuredModel(): string {
  return (
    vscode.workspace.getConfiguration('codeContext').get<string>('ai.model', DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL
  );
}

/**
 * One schema, both providers: Anthropic takes it via `jsonSchemaOutputFormat`,
 * Gemini via `responseJsonSchema`. A single definition is what makes the two
 * narrations genuinely comparable.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    featureName: {
      type: 'string',
      description: 'Short human name for the product area, e.g. "Admin dashboard". Not a directory name.'
    },
    headline: {
      type: 'string',
      description: 'One sentence: what this code does, in terms a non-engineer understands. No jargon.'
    },
    flow: {
      type: 'string',
      description: 'One sentence: how the outside world reaches this code. Use the entry points given.'
    },
    risk: {
      type: 'string',
      description:
        'One or two sentences: what would visibly break for the people who use this product if it changed or failed. Name who is affected and what they would see.'
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'The step number exactly as given in [step:N]. Do not renumber.' },
          text: {
            type: 'string',
            description:
              'That one step said plainly — what it means for the product ("finds the guest\'s check-in form"), not what the code calls ("queries the Submission model"). One short line.'
          }
        },
        required: ['n', 'text'],
        additionalProperties: false
      },
      description:
        'One entry for each numbered step in WHAT IT DOES, carrying its own step number. Do not merge, reorder or invent steps. If a step is already as plain as it can be, repeat it plainly under its own number. Empty array if no steps were given.'
    },
    needs: {
      type: 'string',
      description:
        'One short sentence naming what this needs to run and what it is given, in plain words — "Needs a database connection and a signed-in admin, and takes the form\'s id." Empty string if it requires and takes nothing.'
    },
    origin: {
      type: 'string',
      description:
        'One or two sentences answering WHY THIS WAS BUILT — the need or problem it was added to solve, in product terms. Prefer the reason stated in the commit that introduced it. If the commits only say what changed and not why, infer the need from what it serves (its entry points, what depends on it, what it is committed alongside) and phrase it as a reading: "Looks like it was added so that…". Never restate what the code does — that is the headline, and repeating it here is a wasted sentence.'
    },
    originBasis: {
      type: 'string',
      enum: ['stated', 'inferred'],
      description:
        '"stated" only when a commit message actually gives the reason. "inferred" when you reasoned it from entry points, dependents or co-change. Be honest — this is shown to the reader.'
    },
    history: {
      type: 'string',
      description:
        'One or two sentences on how that original reason has since changed — what was extended, tightened, fixed or reversed, and what that implies for someone editing it now. Empty string if the later commits are routine or say nothing — do not pad, and do not repeat the origin.'
    },
    watchOut: {
      type: 'array',
      items: { type: 'string' },
      description:
        'At most three concrete cautions for someone about to change this, each grounded in the evidence (no tests, a recent AI-assisted change, unreliable caller analysis, a destructive write). Empty array if nothing in the evidence warrants one. Never generic advice.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'low when the evidence is thin or the purpose is genuinely ambiguous.'
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids from the evidence bundle that support these claims, e.g. "entry:1", "step:2", "commit:a1b2c3d".'
    }
  },
  required: ['featureName', 'headline', 'flow', 'risk', 'steps', 'needs', 'origin', 'originBasis', 'history', 'watchOut', 'confidence', 'evidence'],
  additionalProperties: false
} as const;

const SYSTEM = `You translate software evidence into plain language for people who do not read code — product managers, designers, support and QA — without dumbing it down for the engineers reading alongside them.

Rules:
- Use ONLY the evidence given. Never invent a route, job, file, feature name or reason.
- Prefer the words a user of the product would use. "Blocks non-admins from the admin pages" beats "performs an authorization check".
- Do not describe the call graph. Nobody outside engineering cares that a function has three callers.
- If the evidence does not support a claim, say less and set confidence to "low". A short honest answer is correct; a confident guess is a failure.
- Never recommend changes, and never say code is unused or dead — absent callers may mean the analysis missed them.
- Cite the evidence ids you actually relied on.
- "Why it was built" is a question of motive, not behaviour. Read the introducing commit's message first; its body is usually where the reason is. When the commits are silent on motive, reason it out from what the code serves — the route or job it sits behind, who depends on it, what it keeps being changed alongside — and mark it inferred. Guessing is only a failure when you present it as fact.
- The step list is a translation, not a summary: one line out for each line in, same order. If you cannot say a step more plainly than it already is, repeat it plainly rather than merging or skipping it.
- "Watch out" is for things the evidence actually shows. No tests, a recent AI-assisted change, a delete, shaky caller analysis. Never write generic advice like "test your changes".`;

interface Bundle {
  text: string;
  hash: string;
}

/** Everything the model is allowed to see, and nothing else. */
function buildBundle(ctx: ContextResponse, source: string): Bundle {
  const lines: string[] = [];

  lines.push(`SYMBOL: ${ctx.symbol.qualified}()`);
  lines.push(`FILE: ${ctx.symbol.file}`);
  lines.push(`DIRECTORY: ${ctx.feature.path}${ctx.feature.service ? ` (service: ${ctx.feature.service})` : ''}`);
  lines.push('');

  lines.push('SOURCE:');
  lines.push(source.split(/\r?\n/).slice(0, 80).join('\n'));
  lines.push('');

  const ways = ctx.isEntryPoint ? [ctx.isEntryPoint, ...ctx.reachedFrom] : ctx.reachedFrom;
  if (ways.length) {
    lines.push('HOW THE OUTSIDE WORLD REACHES IT:');
    ways.forEach((e, i) =>
      lines.push(`  [entry:${i}] ${e.kind} — ${e.label} (handler: ${e.symbol.qualified}, ${e.framework})`)
    );
  } else {
    lines.push('HOW THE OUTSIDE WORLD REACHES IT: no route, job or command was found leading here.');
  }
  lines.push('');

  const wf = ctx.workflow;
  if (wf && wf.steps.length) {
    lines.push('WHAT IT DOES, IN ORDER (read from the body):');
    if (wf.requires.length) {
      lines.push(`  requires: ${wf.requires.join(', ')}`);
    }
    if (wf.inputs.length) {
      lines.push(`  takes: ${wf.inputs.map((i) => `${i.name} (${i.source})`).join(', ')}`);
    }
    wf.steps.forEach((st, i) => lines.push(`  [step:${i}] ${st.kind} — ${st.label}`));
    lines.push('');
  }

  if (ctx.callers.length) {
    lines.push('USED BY (for context only — do not describe this as a call graph):');
    ctx.callers
      .slice(0, 12)
      .forEach((c, i) =>
        lines.push(`  [caller:${i}] ${c.qualified} in ${c.file} (${c.kind ?? 'call'}, ${c.confidence})`)
      );
    lines.push('');
  }

  const local = ctx.callees.filter((c) => c.confidence !== 'external');
  const libs = ctx.callees.filter((c) => c.confidence === 'external');
  if (local.length || libs.length) {
    lines.push('IT USES:');
    local.slice(0, 10).forEach((c, i) => lines.push(`  [uses:${i}] ${c.qualified} (this codebase)`));
    libs.slice(0, 10).forEach((c, i) => lines.push(`  [lib:${i}] ${c.qualified} (${c.reason ?? 'library'})`));
    lines.push('');
  }

  const origin = ctx.history.find((h) => h.origin);
  if (origin) {
    lines.push('WHY IT WAS ADDED (the commit that introduced it — the statement of intent):');
    lines.push(`  [commit:${origin.sha}] ${origin.date.slice(0, 10)} — ${origin.subject}`);
    if (origin.body) {
      lines.push(`    reason given: ${origin.body}`);
    }
    lines.push('');
  }

  const later = ctx.history.filter((h) => !h.origin);
  if (later.length) {
    lines.push('CHANGED SINCE (newest last):');
    later.forEach((h) => {
      lines.push(`  [commit:${h.sha}] ${h.date.slice(0, 10)} — ${h.subject}${h.aiAssisted ? ' (AI-assisted)' : ''}`);
      if (h.body) {
        lines.push(`    reason given: ${h.body}`);
      }
    });
    if (ctx.historyOlder) {
      lines.push(`  (${ctx.historyOlder} older change(s) not shown)`);
    }
    lines.push('');
  }

  lines.push(`TESTS: ${ctx.tests.count} test file(s) reference it.`);
  lines.push(`NEIGHBOURS BY CO-CHANGE: ${ctx.feature.coChange.map((c) => c.file).join(', ') || 'none'}`);

  const text = lines.join('\n');
  return { text, hash: createHash('sha256').update(text).digest('hex').slice(0, 32) };
}

/* ------------------------------------------------------------------- keys */

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic', description: 'for claude-* models', provider: 'anthropic' as Provider },
      { label: 'Google', description: 'for gemini-* models', provider: 'google' as Provider }
    ],
    { title: 'Which API key?', placeHolder: 'Provider' }
  );
  if (!pick) {
    return;
  }

  const key = await vscode.window.showInputBox({
    title: `${pick.label} API key`,
    prompt: 'Stored in the editor secret storage, never in settings or the repository.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: pick.provider === 'anthropic' ? 'sk-ant-...' : 'AIza...'
  });
  if (key === undefined) {
    return;
  }
  if (!key.trim()) {
    await context.secrets.delete(SECRETS[pick.provider]);
    void vscode.window.showInformationMessage(`Code Context: ${pick.label} key cleared.`);
    return;
  }
  await context.secrets.store(SECRETS[pick.provider], key.trim());
  void vscode.window.showInformationMessage(`Code Context: ${pick.label} key saved.`);
}

async function resolveKey(
  context: vscode.ExtensionContext,
  provider: Provider
): Promise<string | undefined> {
  const stored = await context.secrets.get(SECRETS[provider]);
  if (stored) {
    return stored;
  }
  return provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

type Route =
  | { kind: Provider; model: string; apiKey: string }
  | { kind: 'editor'; model: string; chat: vscode.LanguageModelChat };

/**
 * Which model actually answers.
 *
 * `vscode-lm` asks for the editor's models outright. Any other id uses its
 * provider's key when one is set — and when it isn't, falls back to the
 * editor's models before giving up, so a Copilot user gets narration with no
 * setup at all. The model that answered is what gets recorded and shown, so
 * the fallback is never silent.
 */
async function resolveRoute(context: vscode.ExtensionContext): Promise<Route | { error: string }> {
  const configured = configuredModel();

  if (configured === EDITOR_MODEL) {
    const chat = await pickEditorModel();
    return chat
      ? { kind: 'editor', model: editorModelLabel(chat), chat }
      : {
          error:
            'This editor offers no built-in models to extensions. Pick a claude-* or gemini-* model and set its API key.'
        };
  }

  const provider = providerOf(configured);
  const apiKey = await resolveKey(context, provider);
  if (apiKey) {
    return { kind: provider, model: configured, apiKey };
  }

  const chat = await pickEditorModel();
  if (chat) {
    return { kind: 'editor', model: editorModelLabel(chat), chat };
  }
  return {
    error: `No ${provider === 'anthropic' ? 'Anthropic' : 'Google'} API key, and this editor offers no built-in models. Run "Code Context: Set API key".`
  };
}

export function aiEnabled(): boolean {
  return vscode.workspace.getConfiguration('codeContext').get<boolean>('ai.enabled', false);
}

/* -------------------------------------------------------------- providers */

interface Raw {
  parsed: unknown;
  usage?: { input: number; output: number };
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<Raw> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.parse({
    model,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      format: jsonSchemaOutputFormat(SCHEMA),
      ...(EFFORT_MODELS.has(model) ? { effort: 'low' as const } : {})
    },
    messages: [{ role: 'user', content: prompt }]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to describe this file.');
  }
  return {
    parsed: response.parsed_output,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens }
  };
}

async function callGemini(apiKey: string, model: string, prompt: string): Promise<Raw> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      temperature: 0
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error('The model returned an empty response.');
  }
  return {
    parsed: JSON.parse(text),
    usage: {
      input: response.usageMetadata?.promptTokenCount ?? 0,
      output: response.usageMetadata?.candidatesTokenCount ?? 0
    }
  };
}

/* ------------------------------------------------- the editor's own models */

/**
 * `vscode.lm` — the models the editor itself offers to extensions.
 *
 * In VS Code with GitHub Copilot this is Copilot's model list, Claude models
 * included, with no API key: the editor asks the user once for consent and the
 * usage counts against their Copilot plan. It is the one sanctioned way for an
 * extension to run on a subscription the user already pays for. Other editors
 * built on VS Code may implement the API with an empty list, or not at all;
 * both cases are handled as "not available", never as an error.
 */
export const EDITOR_MODEL = 'vscode-lm';

/**
 * Cheapest capable first. This is translation over a bundle that was already
 * assembled, so a small model is the right default here for the same reason
 * Haiku is the default elsewhere. Matched as substrings of family or id,
 * because vendors spell versions differently.
 */
const EDITOR_PREFERENCE = ['haiku', 'gpt-4o-mini', 'gpt-4.1-mini', 'flash', 'gpt-4.1', 'gpt-4o', 'sonnet'];

export async function editorModels(): Promise<vscode.LanguageModelChat[] | undefined> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    return undefined; // the editor does not implement the API at all
  }
  try {
    return await vscode.lm.selectChatModels();
  } catch {
    return [];
  }
}

export async function pickEditorModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await editorModels();
  if (!models?.length) {
    return undefined;
  }
  const matches = (m: vscode.LanguageModelChat, needle: string) =>
    [m.family, m.id, m.name].some((v) => v?.toLowerCase().includes(needle));

  const wanted = vscode.workspace.getConfiguration('codeContext').get<string>('ai.editorModel', '').trim().toLowerCase();
  if (wanted) {
    const hit = models.find((m) => matches(m, wanted));
    if (hit) {
      return hit;
    }
  }
  for (const needle of EDITOR_PREFERENCE) {
    const hit = models.find((m) => matches(m, needle));
    if (hit) {
      return hit;
    }
  }
  return models[0];
}

export function editorModelLabel(m: vscode.LanguageModelChat): string {
  return `${m.vendor}/${m.family || m.id}`;
}

/**
 * The editor API has no schema-constrained output and no system role, so the
 * instructions and the schema travel in the user turn and the reply is parsed
 * leniently. The shape check downstream still decides whether it is usable.
 */
async function callEditorModel(chat: vscode.LanguageModelChat, prompt: string): Promise<Raw> {
  const message = [
    SYSTEM,
    '',
    'Reply with exactly one JSON object and nothing else — no prose, no code fence. It must match this JSON Schema:',
    JSON.stringify(SCHEMA),
    '',
    prompt
  ].join('\n');

  const cancel = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancel.cancel(), 60_000);
  try {
    const response = await chat.sendRequest(
      [vscode.LanguageModelChatMessage.User(message)],
      { justification: 'Code Context uses it to describe the function you opened in plain language.' },
      cancel.token
    );
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }
    return { parsed: parseLooseJson(text) };
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      if (err.code === vscode.LanguageModelError.NoPermissions.name) {
        throw new Error(
          'Access to the editor\'s models was declined. Re-allow it from the Accounts menu, or set an API key.'
        );
      }
      if (err.code === vscode.LanguageModelError.Blocked.name) {
        throw new Error('The editor blocked the request — usually a quota limit. Try again shortly.');
      }
      if (err.code === vscode.LanguageModelError.NotFound.name) {
        throw new Error(`The editor model ${editorModelLabel(chat)} is no longer available.`);
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
    cancel.dispose();
  }
}

/** Models asked for bare JSON still wrap it in a fence or a sentence sometimes. */
function parseLooseJson(text: string): unknown {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('The model returned an unreadable response.');
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

/** Overload and rate-limit responses, which are worth one retry. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|503|overloaded|UNAVAILABLE|rate.?limit|high demand)\b/i.test(msg);
}

/** Both providers are told the same schema; neither is trusted to have obeyed it. */
function isNarrationShape(v: unknown): v is {
  featureName: string;
  headline: string;
  flow: string;
  risk: string;
  steps: { n: number; text: string }[];
  needs: string;
  origin: string;
  originBasis: 'stated' | 'inferred';
  history: string;
  watchOut: string[];
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
} {
  const o = v as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o.featureName === 'string' &&
    typeof o.headline === 'string' &&
    typeof o.flow === 'string' &&
    typeof o.risk === 'string' &&
    typeof o.history === 'string' &&
    typeof o.origin === 'string' &&
    (o.originBasis === 'stated' || o.originBasis === 'inferred') &&
    typeof o.needs === 'string' &&
    Array.isArray(o.steps) &&
    Array.isArray(o.watchOut) &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    Array.isArray(o.evidence)
  );
}

/**
 * Place each rewritten line against the step it names.
 *
 * Models number from 0 or from 1 depending on the day, so the offset is read
 * off the returned set rather than assumed: a run covering 1..n is 1-based,
 * anything else is taken as-is. Positions nobody claimed stay empty, and the
 * panel falls back to the computed label for those.
 */
function alignSteps(raw: unknown, count: number): string[] {
  if (!count || !Array.isArray(raw)) {
    return [];
  }
  const entries = raw.filter(
    (e): e is { n: number; text: string } =>
      !!e && typeof (e as any).n === 'number' && typeof (e as any).text === 'string'
  );
  if (!entries.length) {
    return [];
  }
  const ns = entries.map((e) => e.n);
  const oneBased = Math.min(...ns) === 1 && Math.max(...ns) === count;
  const out = new Array<string>(count).fill('');
  for (const e of entries) {
    const at = oneBased ? e.n - 1 : e.n;
    if (Number.isInteger(at) && at >= 0 && at < count && !out[at]) {
      out[at] = e.text.trim();
    }
  }
  return out.some((t) => t) ? out : [];
}

/**
 * Returns a narration, or a reason it could not produce one. Callers render the
 * deterministic panel first and fold this in when it arrives — the product has
 * to stay useful with the model switched off.
 */
export async function narrate(
  context: vscode.ExtensionContext,
  ctx: ContextResponse,
  source: string,
  opts: { fresh?: boolean } = {}
): Promise<Narration> {
  const bundle = buildBundle(ctx, source);
  const route = await resolveRoute(context);
  if ('error' in route) {
    return { state: 'error', reason: route.error };
  }
  const model = route.model;
  // Model is part of the key: switching it must re-ask, not replay the old answer.
  const cacheKey = `narration:${model}:${bundle.hash}`;

  // "Re-analyse" means ask again, even when the evidence hasn't moved — the
  // reader has decided the last answer wasn't good enough. The fresh answer
  // still replaces the cached one.
  const cached = opts.fresh ? undefined : context.globalState.get<Narration>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  try {
    const prompt = `Describe this code for someone who does not read code.\n\n${bundle.text}`;
    const call = () =>
      route.kind === 'editor'
        ? callEditorModel(route.chat, prompt)
        : route.kind === 'anthropic'
          ? callAnthropic(route.apiKey, model, prompt)
          : callGemini(route.apiKey, model, prompt);

    // 503 / 429 are capacity, not a verdict on the request. One retry turns the
    // common case of "model busy" back into an answer instead of an error box.
    let raw;
    try {
      raw = await call();
    } catch (first) {
      if (!isTransient(first)) {
        throw first;
      }
      await new Promise((r) => setTimeout(r, 1200));
      raw = await call();
    }

    if (!isNarrationShape(raw.parsed)) {
      return { state: 'error', reason: 'The model returned an unreadable response.' };
    }

    // The model echoed my section headings back as evidence ("SOURCE", "FILE:
    // ...") because nothing checked them. Only ids we actually issued survive.
    const validIds = new Set<string>([
      ...ctx.reachedFrom.map((_, i) => `entry:${i}`),
      ...(ctx.isEntryPoint ? ['entry:0'] : []),
      ...ctx.workflow.steps.map((_, i) => `step:${i}`),
      ...ctx.callers.slice(0, 12).map((_, i) => `caller:${i}`),
      ...ctx.callees.filter((c) => c.confidence !== 'external').slice(0, 10).map((_, i) => `uses:${i}`),
      ...ctx.callees.filter((c) => c.confidence === 'external').slice(0, 10).map((_, i) => `lib:${i}`),
      ...ctx.history.map((h) => `commit:${h.sha}`)
    ]);
    const evidence = raw.parsed.evidence.filter((e) => validIds.has(e)).slice(0, 5);

    // Each rewrite carries the step number it belongs to, so a miscount costs
    // that one line instead of all of them. The old rule — drop everything
    // unless the count matched exactly — meant one merged step silently threw
    // away fourteen good translations and left the raw labels on screen.
    const steps = alignSteps(raw.parsed.steps, ctx.workflow.steps.length);

    // With no commits in evidence, "stated" cannot be true whatever the model
    // says — the reader is told which of the two they are looking at, so the
    // label has to be worth something.
    const originBasis = ctx.history.length ? raw.parsed.originBasis : 'inferred';

    const narration: Narration = {
      state: 'ready',
      ...raw.parsed,
      originBasis,
      steps,
      evidence,
      model,
      evidenceHash: bundle.hash,
      usage: raw.usage
    };
    await context.globalState.update(cacheKey, narration);
    return narration;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: 'error', reason: message.slice(0, 200) };
  }
}

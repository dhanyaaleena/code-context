import * as vscode from 'vscode';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { ContextResponse, Narration } from './types';
import { log } from './lsp';

/** Bump when the prompt or schema changes in a way cached narrations should not survive. */
const PROMPT_VERSION = 5;

/**
 * The one AI call in the product.
 *
 * Everything it receives was computed deterministically. Its job is translation,
 * not discovery: turn routes, callers and commits into sentences a non-engineer
 * can act on, and cite which evidence each claim came from. It is opt-in,
 * cached by the hash of its evidence, and never blocks the deterministic panel.
 *
 * Several providers are supported so narration quality can be compared at a
 * similar price point. The provider is inferred from the model id, so there is
 * no second setting to drift out of sync with the model.
 */

const SECRETS = {
  anthropic: 'codeContext.anthropicApiKey',
  google: 'codeContext.googleApiKey',
  openai: 'codeContext.openaiApiKey',
  xai: 'codeContext.xaiApiKey'
} as const;

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  xai: 'xAI'
};

/** xAI serves an OpenAI-compatible API, so the same SDK reaches Grok. */
const XAI_BASE_URL = 'https://api.x.ai/v1';

type Provider = keyof typeof SECRETS;

const DEFAULT_MODEL = 'claude-haiku-4-5';
/**
 * What Set API key offers for each provider, cheapest first — the first is
 * marked Recommended. Keep in step with the codeContext.ai.model enum.
 */
const MODELS: Record<Provider, { id: string; label: string; note: string }[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fast and inexpensive — plenty for plain-language descriptions.' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Mid-tier — try it if Haiku phrases things poorly.' },
    { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Most capable and most expensive.' }
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Fast and inexpensive.' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'Newer Flash release.' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'Newest pinned Flash release.' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'Always the newest Flash — a moving target.' }
  ],
  openai: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: "OpenAI's most cost-efficient model." },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', note: 'Mid-tier.' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'Most capable and most expensive.' }
  ],
  xai: [
    { id: 'grok-build-0.1', label: 'Grok Build 0.1', note: "The cheapest Grok model in xAI's list." },
    { id: 'grok-4.7', label: 'Grok 4.7', note: "Grok's flagship model." }
  ]
};
/** `output_config.effort` is rejected by Haiku 4.5, so it is sent selectively. */
const EFFORT_MODELS = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']);

function providerOf(model: string): Provider {
  if (model.startsWith('gemini')) {
    return 'google';
  }
  if (/^(gpt-|chatgpt|o\d)/.test(model)) {
    return 'openai';
  }
  if (model.startsWith('grok')) {
    return 'xai';
  }
  return 'anthropic';
}

function configuredModel(): string {
  return (
    vscode.workspace.getConfiguration('codeContext').get<string>('ai.model', DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL
  );
}

/**
 * One schema, every provider: Anthropic takes it via `jsonSchemaOutputFormat`,
 * Gemini via `responseJsonSchema`, OpenAI and xAI via a strict `json_schema`
 * format, and editor models in the prompt. A single definition is what makes
 * the narrations genuinely comparable.
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
          n: { type: 'integer', description: 'The step number exactly as given in [step:N].' },
          text: {
            type: 'string',
            description:
              'That one step in plain words anyone on the team could follow — four to twelve words, no code, no variable or function names. Say a loop or condition the step sits inside the way a person would, inside the sentence: "For every vector, notes its ID", "If the older format comes back, reads the text from its metadata instead". For a line that only opens a loop or condition, give an empty string — its meaning belongs in the steps under it. For a failure, name only what goes wrong ("Unknown namespace").'
          }
        },
        required: ['n', 'text'],
        additionalProperties: false
      },
      description:
        'One entry for every numbered step in WHAT IT DOES, in order, carrying its own number. This is the detailed view — nothing merged or skipped. Empty array if no steps were given.'
    },
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: 'The first step number in this stage, exactly as given in [step:N].' },
          to: { type: 'integer', description: 'The last step number in this stage (the same as from for a single step).' },
          text: {
            type: 'string',
            description:
              'What this stage does, as one plain sentence of four to ten words — what it means for the product ("Finds the guest\'s check-in form and its answers"), not what the code calls. Start with a verb. Leave out what happens on failure: the panel draws failures separately. A stage that is only a failure check names what goes wrong ("Missing column").'
          }
        },
        required: ['from', 'to', 'text'],
        additionalProperties: false
      },
      description:
        'The steps in WHAT IT DOES, grouped into stages a reader can take in at a glance. Each stage is a run of consecutive steps that together do one meaningful thing — a loop and its body, a fetch and the unpacking of its result, a check and the lookup it guards. Every step belongs to exactly one stage, in order, with no gaps or overlaps. Use as few stages as reads naturally: at most five for most functions, up to seven for very long ones; a function of three or four steps may keep one stage per step. Steps are indented under the loop or condition they sit inside; prefer stages that keep a loop or condition together with what is inside it. Empty array if no steps were given.'
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
  required: ['featureName', 'headline', 'flow', 'risk', 'steps', 'stages', 'needs', 'origin', 'originBasis', 'history', 'watchOut', 'confidence', 'evidence'],
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
- The steps list says every step in plain words, one line each, same order. The stages summarise it without losing it: group consecutive steps that serve one purpose, keep their order, and cover every step exactly once. Never invent a step or describe one that isn't there.
- "Watch out" is for things the evidence actually shows. No tests, a recent AI-assisted change, a delete, shaky caller analysis. Never write generic advice like "test your changes".`;

interface Bundle {
  text: string;
  hash: string;
}

/** Everything the model is allowed to see, and nothing else. */
/** From the file extension, so the model reads `err != nil` as Go and `def` as Python. */
function languageOf(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const names: Record<string, string> = {
    py: 'Python', go: 'Go', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', cs: 'C#', php: 'PHP', swift: 'Swift', scala: 'Scala'
  };
  return names[ext] ?? ext;
}

function buildBundle(ctx: ContextResponse, source: string): Bundle {
  const lines: string[] = [];

  lines.push(`SYMBOL: ${ctx.symbol.qualified}()`);
  lines.push(`FILE: ${ctx.symbol.file}`);
  lines.push(`LANGUAGE: ${languageOf(ctx.symbol.file)}`);
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
    // Indented under the loop or condition each step sits inside.
    wf.steps.forEach((st, i) =>
      lines.push(`  ${'    '.repeat((st.scope ?? []).length)}[step:${i}] ${st.header ? st.header.kind : st.kind} — ${st.label}`)
    );
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
  const has = async (p: Provider) => !!(await context.secrets.get(SECRETS[p]));
  const providers: { label: string; description: string; provider?: Provider; remove?: true }[] = [];
  for (const p of Object.keys(SECRETS) as Provider[]) {
    providers.push({
      label: PROVIDER_LABEL[p],
      description: `${MODELS[p].map((m) => m.label).join(', ')}${(await has(p)) ? ' · key saved' : ''}`,
      provider: p
    });
  }
  const anySaved = (await Promise.all((Object.keys(SECRETS) as Provider[]).map(has))).some(Boolean);
  if (anySaved) {
    providers.push({ label: '$(trash) Remove a saved key…', description: '', remove: true });
  }
  const pick = await vscode.window.showQuickPick(providers, { title: 'Set up AI — 1 of 3: provider', placeHolder: 'Which AI provider?' });
  if (!pick) {
    return;
  }
  if (pick.remove) {
    await removeKey(context);
    return;
  }
  const provider = pick.provider!;

  // 2. The model, cheapest first and marked as the recommendation — this is
  // translation over evidence already gathered, which a small model does well.
  const current = configuredModel();
  const modelPick = await vscode.window.showQuickPick(
    MODELS[provider].map((m, i) => ({
      label: m.label,
      description: `${m.id}${i === 0 ? ' · Recommended — cheapest' : ''}${m.id === current ? ' · current' : ''}`,
      detail: m.note,
      id: m.id
    })),
    { title: `Set up AI — 2 of 3: ${PROVIDER_LABEL[provider]} model`, placeHolder: 'Which model?' }
  );
  if (!modelPick) {
    return;
  }

  // 3. The key. With one already saved, leaving the box empty keeps it.
  const saved = await has(provider);
  const key = await vscode.window.showInputBox({
    title: `Set up AI — 3 of 3: ${PROVIDER_LABEL[provider]} API key`,
    prompt: saved
      ? 'A key is already saved — leave this empty to keep it, or paste a new one. Stored in the editor secret storage.'
      : 'Stored in the editor secret storage, never in settings or the repository.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: { anthropic: 'sk-ant-...', google: 'AIza...', openai: 'sk-...', xai: 'xai-...' }[provider]
  });
  if (key === undefined || (!key.trim() && !saved)) {
    return;
  }
  if (key.trim()) {
    await context.secrets.store(SECRETS[provider], key.trim());
  }

  // Choosing a key is the moment someone decides to use the AI layer, so turn
  // it on with the model they picked — no trip to settings.json.
  await turnOnFor(provider, modelPick.id);
  void vscode.window.showInformationMessage(
    `Code Context: AI descriptions are on, using ${modelPick.label}${key.trim() ? '' : ' with your saved key'}. Change it any time with "Code Context: Set API key".`
  );
}

async function removeKey(context: vscode.ExtensionContext): Promise<void> {
  const saved: { label: string; provider: Provider }[] = [];
  for (const p of Object.keys(SECRETS) as Provider[]) {
    if (await context.secrets.get(SECRETS[p])) {
      saved.push({ label: PROVIDER_LABEL[p], provider: p });
    }
  }
  const pick = await vscode.window.showQuickPick(saved, { title: 'Remove which saved key?' });
  if (!pick) {
    return;
  }
  await context.secrets.delete(SECRETS[pick.provider]);
  void vscode.window.showInformationMessage(`Code Context: ${pick.label} key removed.`);
}

/**
 * Turn AI on for a provider: enabled, and a model from that provider. A model
 * already chosen from the same provider is left alone. Returns the model.
 */
async function turnOnFor(provider: Provider, chosen?: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('codeContext');
  const current = config.get<string>('ai.model') ?? DEFAULT_MODEL;
  const model = chosen ?? (current !== 'vscode-lm' && providerOf(current) === provider ? current : MODELS[provider][0].id);
  // User settings, unless this workspace sets its own value — which would win.
  const target = (k: string) =>
    config.inspect(k)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('ai.model', model, target('ai.model'));
  await config.update('ai.enabled', true, target('ai.enabled'));
  return model;
}


async function resolveKey(
  context: vscode.ExtensionContext,
  provider: Provider
): Promise<string | undefined> {
  const stored = await context.secrets.get(SECRETS[provider]);
  if (stored) {
    return stored;
  }
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'google':
      return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'xai':
      return process.env.XAI_API_KEY;
  }
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
async function resolveRoute(context: vscode.ExtensionContext): Promise<Route | { error: string } | { setup: string }> {
  const configured = configuredModel();

  if (configured === EDITOR_MODEL) {
    const chat = await pickEditorModel();
    return chat
      ? { kind: 'editor', model: editorModelLabel(chat), chat }
      : {
          error:
            'This editor offers no built-in models to extensions. Pick a claude-*, gemini-*, gpt-* or grok-* model and set its API key.'
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
  return { setup: PROVIDER_LABEL[provider] };
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

/**
 * OpenAI, through the Responses API — the interface OpenAI's own docs use for
 * Structured Outputs. Strict mode holds the reply to the schema exactly.
 */
async function callOpenAI(apiKey: string, model: string, prompt: string): Promise<Raw> {
  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model,
    instructions: SYSTEM,
    input: prompt,
    text: {
      format: { type: 'json_schema', name: 'narration', schema: SCHEMA as unknown as Record<string, unknown>, strict: true }
    }
  });
  const text = response.output_text;
  if (!text) {
    throw new Error('The model returned an empty response.');
  }
  return {
    parsed: JSON.parse(text),
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  };
}

/**
 * xAI (Grok), through the Chat Completions API — the interface xAI documents
 * for structured outputs on its OpenAI-compatible endpoint.
 */
async function callXai(apiKey: string, model: string, prompt: string): Promise<Raw> {
  const client = new OpenAI({ apiKey, baseURL: XAI_BASE_URL });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'narration', schema: SCHEMA as unknown as Record<string, unknown>, strict: true }
    }
  });
  const message = response.choices[0]?.message;
  if (message?.refusal) {
    throw new Error('The model declined to describe this file.');
  }
  if (!message?.content) {
    throw new Error('The model returned an empty response.');
  }
  return {
    parsed: JSON.parse(message.content),
    usage: { input: response.usage?.prompt_tokens ?? 0, output: response.usage?.completion_tokens ?? 0 }
  };
}

/** Overload and rate-limit responses, which are worth one retry. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|503|overloaded|UNAVAILABLE|rate.?limit|high demand)\b/i.test(msg);
}

/** Every provider is told the same schema; none is trusted to have obeyed it. */
function isNarrationShape(v: unknown): v is {
  featureName: string;
  headline: string;
  flow: string;
  risk: string;
  steps: { n: number; text: string }[];
  stages: { from: number; to: number; text: string }[];
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
    Array.isArray(o.stages) &&
    Array.isArray(o.watchOut) &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    Array.isArray(o.evidence)
  );
}

/** Place each plain line against the step it names; 0- or 1-based is read off the set. */
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
 * Check the model's stages against the computed steps and convert them to
 * 0-based indices.
 *
 * Models number from 0 or from 1 depending on the day, so the offset is read
 * off the result: stages running 1..n are 1-based, 0..n-1 are 0-based. Anything
 * that doesn't tile the steps exactly — a gap, an overlap, a step out of order —
 * is rejected whole: a stage that silently skips a step would hide code from
 * the reader, which is worse than showing every step.
 */
function alignStages(raw: unknown, count: number): { from: number; to: number; text: string }[] {
  if (!count || !Array.isArray(raw)) {
    return [];
  }
  const entries = raw
    .filter(
      (e): e is { from: number; to: number; text: string } =>
        !!e && Number.isInteger((e as any).from) && Number.isInteger((e as any).to) &&
        typeof (e as any).text === 'string' && !!(e as any).text.trim()
    )
    .map((e) => ({ from: Math.min(e.from, e.to), to: Math.max(e.from, e.to), text: e.text.trim() }))
    .sort((x, y) => x.from - y.from);
  if (!entries.length) {
    return [];
  }
  const lo = entries[0].from;
  const hi = entries[entries.length - 1].to;
  const offset = lo === 1 && hi === count ? 1 : lo === 0 && hi === count - 1 ? 0 : -1;
  if (offset < 0) {
    return [];
  }
  let next = 0;
  const out: { from: number; to: number; text: string }[] = [];
  for (const e of entries) {
    const from = e.from - offset;
    const to = e.to - offset;
    if (from !== next) {
      return [];
    }
    out.push({ from, to, text: e.text });
    next = to + 1;
  }
  return next === count ? out : [];
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
  if ('setup' in route) {
    return { state: 'setup', provider: route.setup };
  }
  if ('error' in route) {
    return { state: 'error', reason: route.error };
  }
  const model = route.model;
  // Model is part of the key: switching it must re-ask, not replay the old answer.
  // PROMPT_VERSION changes when the instructions do, so old answers aren't reused under new rules.
  const cacheKey = `narration:${PROMPT_VERSION}:${model}:${bundle.hash}`;

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
          : route.kind === 'openai'
            ? callOpenAI(route.apiKey, model, prompt)
            : route.kind === 'xai'
              ? callXai(route.apiKey, model, prompt)
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

    // Stages must tile the computed steps exactly — in order, every step once —
    // or they are dropped and the panel draws the computed steps instead.
    const stages = alignStages(raw.parsed.stages, ctx.workflow.steps.length);
    // Each plain line carries its step number, so a miscount costs that one
    // line — the panel falls back to the computed label for it.
    const steps = alignSteps(raw.parsed.steps, ctx.workflow.steps.length);

    // What came back, so a panel showing code-like steps can be explained.
    const said = steps.filter((t) => t).length;
    log(
      `narration ${ctx.symbol.qualified} (${model}): ${ctx.workflow.steps.length} steps — ` +
        `plain lines ${said}/${ctx.workflow.steps.length}` +
        `${raw.parsed.steps.length && !steps.length ? ' (unusable numbering)' : ''}, ` +
        `stages ${stages.length ? stages.length : raw.parsed.stages.length ? 'rejected (gap or overlap)' : 'none'}`
    );

    // With no commits in evidence, "stated" cannot be true whatever the model
    // says — the reader is told which of the two they are looking at, so the
    // label has to be worth something.
    const originBasis = ctx.history.length ? raw.parsed.originBasis : 'inferred';

    const narration: Narration = {
      state: 'ready',
      ...raw.parsed,
      originBasis,
      steps,
      stages,
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

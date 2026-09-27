/* global acquireVsCodeApi */
/**
 * The panel, as a ten-second read.
 *
 * Everything the previous version showed is still here. The difference is
 * weight: the name, one sentence, the way in and a warning badge are always
 * visible; the steps, the history and the relationships collapse to a summary
 * line that is worth reading on its own. Sections remember whether you opened
 * them, so anyone who always wants the steps gets the steps.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** Without the model's stages, a flow longer than this folds its tail away. */
  const MAX_FLOW = 7;
  /** The map never grows wider than this, however wide the panel. */
  const MAP_MAX = 520;
  let narration = null;
  let lastCtx = null;
  let open = { steps: false, history: false, touches: false, evidence: false };
  /** Set the moment the button is pressed, before the extension has replied. */
  let spinning = false;
  /** The function's code changed after this was analysed. */
  let stale = false;
  /** AI on or off, and whether any key exists — sent by the extension. */
  let ai = { enabled: false, hasKey: false, known: false };
  /** "Break it down": every computed step instead of the model's stages. Remembered. */
  let everyStep = false;

  const saved = vscode.getState();
  if (saved) {
    lastCtx = saved.ctx || null;
    narration = saved.narration || null;
    open = Object.assign(open, saved.open || {});
    everyStep = !!saved.everyStep;
    stale = !!saved.stale;
    if (lastCtx) {
      render(lastCtx);
    }
  }

  window.addEventListener('message', (e) => {
    if (!e.data) {
      return;
    }
    if (e.data.type === 'context') {
      const next = e.data.payload;
      // Same function, re-analysed: keep showing the last answer until the new
      // one arrives. Blanking it made every background refresh flicker, even
      // when the new answer turned out to be the same cached one.
      const same =
        lastCtx &&
        lastCtx.symbol.file === next.symbol.file &&
        lastCtx.symbol.qualified === next.symbol.qualified;
      if (!same) {
        narration = null;
      }
      spinning = false;
      stale = false;
      lastCtx = next;
      render(lastCtx);
    } else if (e.data.type === 'ai') {
      ai = { enabled: !!e.data.enabled, hasKey: !!e.data.hasKey, known: true };
      if (lastCtx) {
        render(lastCtx);
      }
    } else if (e.data.type === 'stale') {
      stale = !!e.data.on;
      if (lastCtx) {
        render(lastCtx);
      }
    } else if (e.data.type === 'narration') {
      narration = e.data.payload;
      if (narration && narration.state !== 'loading') {
        spinning = false;
      }
      if (lastCtx) {
        render(lastCtx);
      }
    }
  });

  // The map is drawn at real pixel size, so a resized panel redraws it.
  let lastWidth = 0;
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = root.clientWidth;
      if (lastCtx && Math.abs(w - lastWidth) > 24) {
        render(lastCtx);
      }
    }, 150);
  });

  function persist() {
    vscode.setState({ ctx: lastCtx, narration, open, stale, everyStep });
  }

  function render(ctx) {
    persist();
    lastWidth = root.clientWidth;
    root.innerHTML = [headline(ctx), sections(ctx)].join('');
    wire(ctx);
    requestAnimationFrame(syncPulse);
  }

  /**
   * A section that is about to receive model-written content says so.
   *
   * Without this the panel looked finished the moment the computed content
   * landed, and the sentences that arrived a second later read as if they had
   * always been there. The amber rule is the same one that marks the finished
   * text, so the space the model will fill is visible before it fills it.
   */
  function aiPending(what) {
    if (!narration || narration.state !== 'loading') {
      return '';
    }
    return `<div class="ai-inline pending">
      <p class="why" style="margin:0">${esc(what)}</p>
    </div>`;
  }

  /* ------------------------------------------------------------- the glance */

  function headline(ctx) {
    const n = narration && narration.state === 'ready' ? narration : null;
    const edited = ctx.dirty ? `<span class="edited" title="Unsaved edits since ${esc(ctx.indexedAt)}">unsaved edits</span>` : '';

    // Computed identity sits outside the amber rule; everything inside it was
    // written by the model. Keeping that boundary visible is the trust mechanism,
    // so it survives even when there is no narration to put in it.
    const busy = spinning || (narration && narration.state === 'loading');
    // One control for AI: a switch whose label says what it does. Off, it
    // offers to explain; with no key yet, clicking it opens setup.
    const aiRow = ai.known
      ? `<button class="aiswitch${ai.enabled ? ' on' : ''}" id="aiswitch" role="switch" aria-checked="${ai.enabled}"
              title="${ai.enabled ? 'Turn AI explanations off — your API key is kept' : ai.hasKey ? 'Turn on AI explanations' : 'Set up AI: choose a provider and add a key'}">
          <span class="track"><span class="knob"></span></span><span class="ai-lbl">✨ ${ai.enabled ? 'AI on' : '<span class="long">Explain with </span>AI'}</span></button>`
      : '';
    const ident = `<div class="ident">
      <div class="names">
        <div class="sym" title="${esc(ctx.symbol.qualified)}() — ${esc(ctx.symbol.file)} · line ${ctx.symbol.startLine + 1}">${esc(ctx.symbol.qualified)}()${edited}</div>
      </div>
      <div class="ctrls">${aiRow}
        <button class="iconbtn reanalyse${busy ? ' busy' : ''}${stale && !busy ? ' stale' : ''}" id="reanalyse"
                title="Re-analyse" aria-label="Re-analyse this function"${busy ? ' disabled' : ''}>${ICON.refresh}</button>
      </div>
      ${facts(ctx)}
    </div>`;

    // Changed code is announced, never re-analysed behind the reader's back.
    // An agent mid-edit would otherwise bill for every half-written version.
    const staleBar =
      stale && !busy
        ? `<button class="stalebar" id="stalebar" title="Re-analyse">
             <span class="dot"></span>
             <span class="msg">This function changed since it was analysed.</span>
             <span class="act">Re-analyse</span>
           </button>`
        : '';

    if (!n) {
      const note =
        narration && narration.state === 'loading'
          ? 'piecing this together…'
          : narration && narration.state === 'error'
            ? `No description — ${narration.reason}`
            : ctx.summary;
      // Not set up yet — no key, AI never turned on. Only then; a request
      // that failed says why and offers Try again instead.
      // AI is off: no summary box. The computed one only restated the journey
      // and the numbers shown right below; Detail still has it.
      if (!narration || narration.state === 'setup') {
        // No key saved yet: one line saying what a key gets you.
        const nokey = ai.known && !ai.hasKey
          ? `<button class="nokey" data-setup>Get the full picture, turn the toggle on, and AI will explain this function.</button>`
          : '';
        return `${ident}${staleBar}${nokey}`;
      }
      // An error is not "still working": no pulse, and a way to ask again.
      const failed = narration && narration.state === 'error';
      const loading = narration && narration.state === 'loading';
      return `${ident}${staleBar}<div class="ai ${failed ? 'failed' : loading ? 'pending' : 'plain'}"><p class="lead">${esc(note)}</p>${
        failed ? `<button class="linkbtn retry" data-retry>Try again</button>` : ''
      }</div>`;
    }

    return `${ident}${staleBar}
    <div class="ai">
      <div class="top">
        ${n.featureName ? `<span class="feat">${esc(n.featureName)}</span>` : ''}
        <span class="model">${esc(shortModel(n.model))}${n.cached ? ' · cached' : ''}</span>
      </div>
      <p class="lead">${esc(n.headline)}</p>
    </div>`;
  }

  /**
   * One line under the name: how the outside world reaches it (the first way
   * in, "+N" for the rest), then the numbers. The route jumps to its handler.
   */
  function facts(ctx) {
    const entries = ctx.isEntryPoint ? [ctx.isEntryPoint] : ctx.reachedFrom || [];
    const [first, ...rest] = entries;
    const way = first
      ? `<span class="way hit" data-file="${esc(first.symbol.file)}" data-line="${first.symbol.line}" title="${esc(
          [first, ...rest].map((e) => e.label).join('\n')
        )}">${entryBits(first)}${rest.length ? `<span class="more">+${rest.length}</span>` : ''}</span>`
      : '';
    return `<div class="facts-line">${[way, ...statBits(ctx)].filter(Boolean).map((b) => `<span>${b}</span>`).join('')}</div>`;
  }

  function entryBits(e) {
    const http = e.kind === 'http' ? /^([A-Z]+(?:\/[A-Z]+)*)\s+(.+)$/.exec(e.label) : null;
    const badge = http
      ? `<span class="method m-${METHOD_CLASS[http[1].split('/')[0]] || 'other'}">${esc(http[1])}</span>`
      : `<span class="method m-other">${esc(KIND_BADGE[e.kind] || e.kind)}</span>`;
    const text = http ? http[2] : e.label.replace(/^(background job|scheduled|command):\s*|^rpc\s+/, '');
    return `${badge}<span class="jpath">${esc(text)}</span>`;
  }


  /** The numbers worth knowing, in one quiet line. Nothing is repeated below. */
  function statBits(ctx) {
    const bits = [];
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (ctx.callers.length) {
      bits.push(plural(ctx.callers.length, 'caller'));
    }
    const calls = ownCalls(ctx).length;
    if (calls) {
      bits.push(plural(calls, 'call'));
    }
    bits.push(
      ctx.tests.count
        ? plural(ctx.tests.count, 'test file')
        : '<span class="bad">no tests</span>'
    );
    const changes = ctx.history.length + (ctx.historyOlder || 0);
    if (changes) {
      bits.push(plural(changes, 'change'));
    }
    return bits;
  }

  /* ---------------------------------------------------------- the disclosures */

  function sections(ctx) {
    return [
      section('steps', 'What it does', stepsSummary(ctx), stepsBody(ctx)),
      section('history', 'How it got here', historySummary(ctx), historyBody(ctx)),
      section('touches', 'What it touches', touchesSummary(ctx), touchesBody(ctx)),
      section('evidence', 'Detail', detailSummary(ctx), detailBody(ctx))
    ]
      .filter(Boolean)
      .join('');
  }

  function section(id, title, summary, body) {
    if (!body) {
      return '';
    }
    return `<details class="sec" data-sec="${id}"${open[id] ? ' open' : ''}>
      <summary>${ICON.chevron}<span class="t">${esc(title)}</span><span class="s">${esc(summary)}</span></summary>
      <div class="secbody">${body}</div>
    </details>`;
  }

  /* -- what it does -- */

  function stepsSummary(ctx) {
    const w = ctx.workflow;
    if (!w || !w.steps.length) {
      return 'nothing recognised';
    }
    // The shape of the work reads better than the first word of each line.
    const WORD = {
      read: 'reads',
      filter: 'filters',
      compute: 'calculates',
      call: 'calls out',
      loop: 'loops',
      branch: 'branches',
      write: 'writes',
      return: 'returns',
      guard: 'checks'
    };
    const all = buildFlow(w.steps, shownStages(), plainSteps(w));
    const exits = all.reduce((n, node) => n + node.exits.filter((x) => !x.calm).length, 0);
    const shape = all
      .map((node) => WORD[node.kind])
      .filter((v, i, a) => v && a.indexOf(v) === i)
      .slice(0, 2)
      .join(', ');
    const main = `${all.length} step${all.length === 1 ? '' : 's'}`;
    return exits ? `${main} · ${exits} way${exits === 1 ? '' : 's'} to fail` : `${main}${shape ? ` · ${shape}` : ''}`;
  }

  function stepsBody(ctx) {
    const w = ctx.workflow;
    if (!w || (!w.steps.length && !w.requires.length)) {
      return '';
    }
    const grouped = readyStages();
    const stages = shownStages();
    const needs = narration && narration.state === 'ready' ? narration.needs : '';

    const meta = needs
      ? `<p class="needs">${esc(needs)}</p>`
      : [
          w.requires.length
            ? `<div class="facts"><span class="lbl">Needs</span>${w.requires
                .map((r) => `<span class="chip">${esc(r)}</span>`)
                .join('')}</div>`
            : '',
          w.inputs.length
            ? `<div class="facts"><span class="lbl">Takes</span>${w.inputs
                .map((i) => `<span class="chip">${esc(i.name)}</span>`)
                .join('')}</div>`
            : ''
        ].join('');

    const plain = plainSteps(w);
    const flow = buildFlow(w.steps, stages, plain);
    const file = esc(ctx.symbol.file);
    // Without stages a long function is still a long list: show the start and
    // fold the rest behind one row, so the section stays a glance.
    const cap = stages.length || everyStep ? flow.length : flow.length > MAX_FLOW ? MAX_FLOW - 1 : flow.length;
    const steps =
      renderFlow(flow, file, cap) +
      (cap < flow.length
        ? `<li class="fc-more"><div class="fc-row"><span class="fc-node" data-expand>+${flow.length - cap} more steps</span></div></li>`
        : '');
    // Only the colours actually used get a key, so a function that never
    // writes doesn't carry a "changes data" entry nobody needs to learn.
    const used = new Set(flow.map((node) => KIND_CLASS[node.kind]).filter(Boolean));
    used.delete('k-error');
    const key = KEY.filter(([cls]) => used.has(cls));
    // Grouped into stages, the exact steps are one click away — and back.
    const toggle = grouped.length && grouped.some((g) => g.to > g.from)
      ? `<button class="linkbtn fc-toggle" data-every-step>${
          everyStep ? 'Show grouped' : `Break it down · ${buildFlow(w.steps, [], plain).length} steps`
        }</button>`
      : '';
    const keyHtml = key.length || toggle
      ? `<div class="key">${key.map(([cls, word]) => `<span class="${cls}">${esc(word)}</span>`).join('')}${toggle}</div>`
      : '';

    const chart = `${steps ? `<div class="fcwrap"><ol class="fc">${steps}</ol></div>` : ''}${keyHtml}`;
    const pending = aiPending('unpacking the steps…');
    if (pending) {
      return `${pending}${meta}${chart}`;
    }

    // The model answered but its plain-language steps didn't come through —
    // or only some did. Say so, so code-like lines aren't mistaken for its
    // answer, and offer to ask again.
    const ready = narration && narration.state === 'ready';
    const unsaid = w.steps.filter((st, i) => !st.header && !plain[i]).length;
    const missing = ready && w.steps.length && !stages.length && (!plain.length || (everyStep || !grouped.length) && unsaid > 0);
    const fallback = missing
      ? `<div class="fallback">${
          plain.length
            ? `${unsaid} step${unsaid === 1 ? ' is' : 's are'} shown as read from the code — the plain-language version didn't come through for ${unsaid === 1 ? 'it' : 'them'}.`
            : "These steps are shown as read from the code — the plain-language version didn't come through this time."
        } <button class="linkbtn" data-retry>Try again</button></div>`
      : '';

    // Same rule as the headline block: if a model wrote the words, the amber
    // rule marks them. Steps it didn't write sit outside the rule.
    const aiWroteSteps = stages.length || (plain.length && !missing);
    if (aiWroteSteps) {
      return `<div class="ai-inline">${meta}${chart}</div>`;
    }
    return `${needs ? `<div class="ai-inline">${meta}</div>` : meta}${fallback}${chart}`;
  }

  /** The flowchart: one box per step or stage, joined by arrows, exits to the right. */
  function renderFlow(nodes, file, cap = nodes.length) {
    return nodes
      .map((n, i) => `<li class="${i >= cap ? 'extra' : ''}">${flowRow(n, file)}</li>`)
      .join('');
  }

  function flowRow(node, file) {
    const exits = node.exits
      .map((x) => `<span class="exit${x.calm ? ' calm' : ''} hit" data-file="${file}" data-line="${x.line}" title="${esc(x.full)}">${esc(x.text)}</span>`)
      .join('');
    const kind = KIND_CLASS[node.kind] || 'k-flow';
    const box = node.line === undefined
      ? `<span class="fc-node ${kind}">${esc(node.text)}</span>`
      : `<span class="fc-node ${kind} hit" data-file="${file}" data-line="${node.line}" title="${esc(node.full)}">${esc(node.text)}</span>`;
    return `<div class="fc-row${exits ? ' has-exit' : ''}">${box}${
      exits ? `<span class="fc-branch"></span><span class="exits">${exits}</span>` : ''
    }</div>`;
  }

  /** The stages to draw: none when the reader asked to see every step. */
  function shownStages() {
    return everyStep ? [] : readyStages();
  }

  /** The model's stages, when it gave some that check out for these steps. */
  function readyStages() {
    return narration && narration.state === 'ready' && Array.isArray(narration.stages) ? narration.stages : [];
  }

  /** The model's plain line for each step, when it gave them. */
  function plainSteps(w) {
    const p = narration && narration.state === 'ready' && Array.isArray(narration.steps) ? narration.steps : [];
    return p.length === w.steps.length ? p : [];
  }

  /**
   * Steps — or the model's stages of them — as a flat run of boxes. Nesting is
   * not drawn: with the model's words, a condition or loop is said inside the
   * sentence ("For every vector, notes its ID"), so the lines that only open
   * one are left out rather than shown as code.
   */
  function buildFlow(steps, stages, plain = []) {
    const units = stages.length
      ? stages.map((g) => ({ from: g.from, to: g.to, text: g.text }))
      : steps.map((_, i) => ({ from: i, to: i, text: plain[i] || '' }));
    const nodes = [];
    for (const u of units) {
      const members = steps.slice(u.from, u.to + 1);
      if (!members.length) {
        continue;
      }
      if (!stages.length && plain.length && members[0].header) {
        continue;
      }
      const node = nodeOf(members, u.text, nodes, members.map((_, k) => plain[u.from + k] || ''));
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  /**
   * One box for a group of steps. Its failures — error steps, and the "…, or
   * answers 400 if that fails" folded into its other steps — become its exits.
   * A group that is only failures branches off the box before it; at the very
   * top it becomes a check of its own. Returns null when it was attached that way.
   */
  function nodeOf(members, words, before, own = []) {
    const exits = [];
    const main = [];
    members.forEach((st, k) => {
      // The model's line for this very step, else the group's when it is the only one.
      const said = own[k] || (members.length === 1 ? words : '');
      if (st.kind === 'error') {
        // Python keeps the raise's message in detail; it says more than the exception's name.
        const message = st.detail && /\s/.test(st.detail) && !/[=(){}]/.test(st.detail) ? st.detail : '';
        exits.push({ text: exitText(st.label, said || message), full: st.label, line: st.line });
        return;
      }
      // An early return that isn't a failure — "stops early when ids is
      // missing, returning []" — branches off too, in grey rather than red.
      const early = /^stops early when (.+?)(?:, returning (.+))?$/.exec(st.label);
      if (early) {
        exits.push({
          text: said
            ? clip(said.replace(/[.]$/, ''), 44)
            : `${early[2] ? `returns ${clip(early[2], 16)}` : 'stops'} · ${clip(early[1], 30)}`,
          full: st.label,
          line: st.line,
          calm: true
        });
        return;
      }
      // Python's handler step — "handles A or B, or any other error — passes
      // it on or answers 401 or answers 500": its outcomes are exits.
      const handler = /^handles (.+?) — (.+)$/.exec(st.label);
      if (handler) {
        handler[2].split(/ or (?=answers|passes|fails|stops|returns)/).forEach((o) =>
          exits.push({ text: exitText(o), full: st.label, line: st.line })
        );
        const caught = handler[1].replace(/, or any other error$/, '').split(/,? or |, /).filter(Boolean);
        main.push({ st, text: caught.length === 1 && !/any other error/.test(handler[1]) ? `Catches ${caught[0]}` : 'Catches errors' });
        return;
      }
      const folded = /^(.*?),? or (.+?) if that fails$/.exec(st.label);
      if (folded) {
        exits.push({ text: exitText(folded[2]), full: st.label, line: st.line });
      }
      const text = folded ? folded[1] : st.label;
      // A loop heads its body as "for each id" — singular, like the code's own variable.
      const loopText = text.replace(/^goes through each (\S+)/, (_, w) =>
        `for each ${w.length > 2 ? w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1') : w}`
      );
      main.push({ st, text: st.header && st.header.kind === 'loop' ? loopText : text });
    });

    const detail = members.map((st) => `• ${st.label}  (line ${st.line + 1})`).join('\n');
    if (!main.length) {
      let host = before[before.length - 1];
      if (!host) {
        host = { kind: 'guard', text: checkText(members[0].label), full: detail, line: members[0].line, exits: [] };
        before.push(host);
      }
      host.exits.push(...exits);
      return null;
    }
    const kinds = main.map((m) => m.st.kind);
    const kind = kinds.includes('write')
      ? 'write'
      : kinds[kinds.length - 1] === 'return' && kinds.length === 1
        ? 'return'
        : kinds.find((k) => k !== 'return') || kinds[0];
    return {
      kind,
      text: sentence(words || main[0].text),
      full: words ? `${words}\n${detail}` : detail,
      line: main[0].st.line,
      exits
    };
  }

  /** "answers 409 when the error is ErrOutOfStock (“out of stock”)" → "409 · out of stock". */
  function exitText(label, words) {
    const l = String(label);
    const code = /\b(?:answers|with|returns?)\s+([1-5]\d\d)\b/.exec(l) || /\b([45]\d\d)\b/.exec(l);
    const verb = code
      ? code[1]
      : /^crash|panic/.test(l)
        ? 'crashes'
        : /passes (?:the error|it) on/.test(l)
          ? 'passes error on'
          : /^fails/.test(l)
            ? 'fails'
            : 'stops';
    const quoted = /[“"]([^”"]{2,})[”"]/.exec(l);
    const failsWith = /^fails:\s*(.+?)(?:\s+when\s|$)/.exec(l);
    const when = /\bwhen\s+(.+?)(?:\s*\(|$)/.exec(l);
    // The model's words for a failure ("Card declined") beat the code's condition.
    // Models like to prefix "Return error:"; the chip is already an error.
    const said = words
      ? words.replace(/[.]$/, '').replace(/^(?:stops?|fails?|exits?|bails? out|gives? up)\s+(?:early\s+)?(?:if|when)\s+/i, '').replace(/^(?:returns?|raises?|throws?|sends?(?: back)?|responds? with|answers? with)\s+(?:an?\s+)?(?:\d{3}\s+)?(?:error|exception)?\s*[:—-]?\s*/i, '')
      : '';
    let reason = said ? said : quoted ? quoted[1] : failsWith ? failsWith[1] : when ? when[1] : '';
    reason = reason.replace(/^the error is\s+/, '').replace(/\s+/g, ' ').trim();
    return reason ? `${verb} · ${clip(reason, 34)}` : verb;
  }

  /** "stops early when req.CustomerID == 0" → "Checks customer ID". */
  function checkText(label) {
    const cond = /\bwhen\s+(.+?)(?:\s*\(|$)/.exec(String(label));
    const subject = cond && /(?:not\s+)?([A-Za-z_][\w.]*)/.exec(cond[1].replace(/^(?:not|no)\s+/, ''));
    if (!subject) {
      return 'Checks the input';
    }
    // `index.has_namespace` is a check on the namespace.
    return `Checks ${humanName(subject[1].split('.').pop().replace(/^(?:has|is|can)_(?=\w)/, ''))}`;
  }

  /** `CustomerID`, `customer_id`, `customerId` → "customer ID". */
  function humanName(id) {
    return String(id)
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ')
      .map((w) => (/^(id|url|uri|ip|api|csv|sku)$/i.test(w) ? w.toUpperCase() : w.toLowerCase()))
      .join(' ')
      .trim();
  }

  function sentence(t) {
    const s = String(t).trim();
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  /* -- how it got here -- */

  function historySummary(ctx) {
    if (!ctx.history.length) {
      return 'no git history';
    }
    const n = ctx.history.length + (ctx.historyOlder || 0);
    const last = ctx.history[ctx.history.length - 1];
    return `latest ${monthYear(last.date)}`;
  }

  function historyBody(ctx) {
    if (!ctx.history.length) {
      return '';
    }
    const why = whyBlock() || aiPending('digging up the backstory…');
    const rows = ctx.history
      .slice()
      .reverse()
      .map(
        (h, i) => `<li class="hrow hit${i === 0 ? ' first' : ''}" data-sha="${esc(h.sha)}" title="Show commit ${esc(h.sha)}">
          <span class="dot"></span>
          <span class="hbody">
            <span class="hsub">${esc(h.subject)}${
              h.origin ? '<span class="origin">added here</span>' : ''
            }</span>
            <div class="hmeta">${esc(dayMonthYear(h.date))} · ${esc(h.author)}${
              h.aiAssisted ? ' · <span class="bad">AI-assisted</span>' : ''
            }</div>
          </span>
        </li>`
      )
      .join('');
    const co = ctx.feature.coChange.length
      ? `<div class="cochange"><span class="lbl">Often changes with</span>${ctx.feature.coChange
          .map((c) => `<span class="chip" title="${esc(c.file)}">${esc(shortFile(c.file))} ×${c.commits}</span>`)
          .join('')}</div>`
      : '';
    const older = ctx.historyOlder
      ? `<p class="olderline">+${ctx.historyOlder} older change${ctx.historyOlder === 1 ? '' : 's'}</p>`
      : '';
    return `${why}<ul class="hlist">${rows}</ul>${older}${co}`;
  }

  /**
   * The reason, before the log.
   *
   * A list of commit subjects tells you what happened to this code, never why
   * anyone wrote it. That answer is either stated in the introducing commit or
   * it is a reading of what the code serves — and the reader is told which,
   * because an inference presented as a fact is worse than no answer.
   */
  function whyBlock() {
    if (!narration || narration.state !== 'ready') {
      return '';
    }
    const origin = narration.origin;
    const since = narration.history;
    if (!origin && !since) {
      return '';
    }
    // No heading: the amber rule already says a model wrote this, and the
    // section title already says what it is about. The one thing kept is the
    // "inferred" mark, because without it a guess reads exactly like a fact.
    const tag = narration.originBasis === 'inferred' ? '<span class="aitag">inferred</span>' : '';
    return `<div class="ai-inline">${tag}
      ${origin ? `<p class="why" style="margin:0">${esc(origin)}</p>` : ''}
      ${since ? `<p class="why since">${esc(since)}</p>` : ''}
    </div>`;
  }

  /* -- what it touches -- */

  function ownCalls(ctx) {
    return ctx.callees.filter((c) => c.confidence !== 'external' && c.confidence !== 'unresolved');
  }

  /** The counts are already in the stats line; this says what opening it shows. */
  function touchesSummary(ctx) {
    return ctx.impact.transitive
      ? `map · ${ctx.impact.transitive} further out`
      : 'map of callers and calls';
  }

  function touchesBody(ctx) {
    const calls = ownCalls(ctx);
    if (!calls.length && !ctx.callers.length) {
      return '';
    }
    const upstreamCovered =
      ctx.callers.length > 0 && (ctx.reachedFrom || []).length >= ctx.callers.length;
    const callers = upstreamCovered ? [] : ctx.callers;
    if (!callers.length && !calls.length) {
      return `<p class="nomap">Everything that calls this is a way in, shown at the top. It calls nothing else in this workspace.</p>`;
    }

    const list = (title, items) =>
      items.length > mapFits(items.length)
        ? `<details class="more"><summary>${esc(title)} (${items.length})</summary><ul>${items
            .map(
              (c) => `<li class="hit" data-file="${esc(c.file)}" data-line="${c.line}">
                <b>${esc(c.qualified)}</b>
                <span class="where">${esc(shortFile(c.file))}${
                  c.confidence !== 'resolved' ? ` · ${esc(c.confidence)}` : ''
                }</span></li>`
            )
            .join('')}</ul></details>`
        : '';

    return `${mapSvg(ctx, callers, calls)}
      <div class="legend"><span><i></i>confirmed</span><span><i class="d"></i>a guess</span>
        <span class="hint">click a box to go there</span></div>
      ${list('See all callers', callers)}${list('See everything it calls', calls)}`;
  }

  /**
   * The navigable map. Callers above, this symbol in the middle, what it calls
   * below — every box is a jump. Drawn at the panel's real pixel size, never
   * stretched: text stays the size of the text around it however wide the
   * panel is, and the graph stops growing past MAP_MAX.
   */
  function mapSvg(ctx, callers, calls) {
    const W = Math.round(Math.max(240, Math.min(MAP_MAX, (root.clientWidth || 360) - 2)));
    const BOX_H = 34;
    const BOX_MAX = 168;
    const GAP = 10;
    const ROW_GAP = 30;
    // As many boxes per row as fit at a readable width, then "+N more".
    const perRow = mapPerRow(W);

    const fit = (items) => {
      const shown = items.length > perRow ? items.slice(0, perRow - 1) : items;
      return { shown, hidden: items.length - shown.length };
    };
    const upFit = fit(callers);
    const downFit = fit(calls);

    const hasUp = callers.length > 0;
    const hasDown = calls.length > 0;
    const FOCUS_H = 36;
    const yUp = 1;
    const yFocus = hasUp ? yUp + BOX_H + ROW_GAP : 1;
    const yDown = yFocus + FOCUS_H + ROW_GAP;
    const H = (hasDown ? yDown + BOX_H : yFocus + FOCUS_H) + 2;

    const row = (nodes, hidden, y) => {
      const count = nodes.length + (hidden > 0 ? 1 : 0);
      if (!count) {
        return { boxes: [], svg: '' };
      }
      const w = Math.min(BOX_MAX, (W - GAP * (count - 1)) / count);
      const left = (W - (w * count + GAP * (count - 1))) / 2;
      const boxes = nodes.map((n, i) => ({ x: left + i * (w + GAP), w, node: n }));
      if (hidden > 0) {
        boxes.push({ x: left + nodes.length * (w + GAP), w, node: null, label: `+${hidden} more` });
      }
      const svg = boxes
        .map((b) => {
          const n = b.node;
          const guess = n && n.confidence !== 'resolved';
          const nav = n
            ? ` class="hit${guess ? ' guess' : ''}" data-file="${esc(n.file)}" data-line="${n.line}"><title>${esc(n.qualified)} — ${esc(n.file)}${guess ? ' (a guess)' : ''}</title`
            : ' class="dim"';
          const label = n ? n.name : b.label;
          const sub = n ? String(n.file).split('/').pop() : 'listed below';
          return `<g${nav}>
            <rect x="${b.x + 0.5}" y="${y + 0.5}" width="${b.w - 1}" height="${BOX_H - 1}" rx="5"
              class="box${guess ? ' g' : ''}${n ? '' : ' more'}"/>
            <text x="${b.x + 10}" y="${y + 15}" class="nm${n ? '' : ' mut'}">${esc(clip(label, Math.floor((b.w - 18) / 6.9)))}</text>
            <text x="${b.x + 10}" y="${y + 27}" class="fl">${esc(clip(sub, Math.floor((b.w - 18) / 5.6)))}</text>
          </g>`;
        })
        .join('');
      return { boxes, svg };
    };

    const upRow = row(upFit.shown, upFit.hidden, yUp);
    const downRow = row(downFit.shown, downFit.hidden, yDown);

    const name = `${ctx.symbol.name}()`;
    const focusW = Math.min(W - 20, Math.max(150, name.length * 7.4 + 36));
    const focusX = (W - focusW) / 2;

    // Edges leave and arrive spread across the focus box, not all at its centre.
    const anchors = (n) => {
      if (!n) {
        return [];
      }
      const span = Math.min(focusW - 40, n * 40);
      const left = W / 2 - span / 2;
      return n === 1 ? [W / 2] : Array.from({ length: n }, (_, i) => left + (span / (n - 1)) * i);
    };
    const upA = anchors(upRow.boxes.length);
    const downA = anchors(downRow.boxes.length);

    const edge = (x1, y1, x2, y2, guess) => {
      const mid = (y1 + y2) / 2;
      return `<path d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2 - 3}"
        class="edge${guess ? ' g' : ''}" marker-end="url(#cc-ah${guess ? 'g' : ''})"/>`;
    };
    const isGuess = (b) => b.node && b.node.confidence !== 'resolved';

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="map" role="img">
      <defs>
        <marker id="cc-ah" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0.5 L5,3 L0,5.5 Z" class="ah"/></marker>
        <marker id="cc-ahg" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0.5 L5,3 L0,5.5 Z" class="ah g"/></marker>
      </defs>
      ${upRow.boxes.map((b, i) => edge(b.x + b.w / 2, yUp + BOX_H, upA[i], yFocus, isGuess(b))).join('')}
      ${downRow.boxes.map((b, i) => edge(downA[i], yFocus + FOCUS_H, b.x + b.w / 2, yDown, isGuess(b))).join('')}
      ${upRow.svg}
      <rect x="${focusX + 0.5}" y="${yFocus + 0.5}" width="${focusW - 1}" height="${FOCUS_H - 1}" rx="6" class="focus"/>
      <text x="${W / 2}" y="${yFocus + 16}" text-anchor="middle" class="nm here">${esc(clip(name, Math.floor((focusW - 16) / 7.2)))}</text>
      <text x="${W / 2}" y="${yFocus + 28}" text-anchor="middle" class="fl acc">this function</text>
      ${downRow.svg}
    </svg>`;
  }

  /** How many of `n` nodes the map draws as boxes in one row at this width. */
  function mapFits(n) {
    const perRow = mapPerRow(Math.max(240, Math.min(MAP_MAX, (root.clientWidth || 360) - 2)));
    return n > perRow ? perRow - 1 : n;
  }

  /** Boxes per row: as many as fit at a readable width, two to four. */
  function mapPerRow(W) {
    return Math.max(2, Math.min(4, Math.floor((W + 10) / 115)));
  }

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
  }

  /* -- detail -- */

  function detailSummary(ctx) {
    const n = narration && narration.state === 'ready' ? narration : null;
    const cautions = n ? (n.watchOut || []).length : 0;
    return cautions ? `${cautions} caution${cautions === 1 ? '' : 's'}` : 'tests and evidence';
  }

  function detailBody(ctx) {
    const n = narration && narration.state === 'ready' ? narration : null;
    const rows = [];
    if (n && n.risk) {
      rows.push(['If it breaks', n.risk]);
    }
    if (n && n.flow) {
      rows.push(['How it is reached', n.flow]);
    }
    if (!n) {
      rows.push(['Computed summary', ctx.summary]);
    }
    const watch =
      n && (n.watchOut || []).length
        ? `<div class="watch"><div class="lbl">Watch out</div><ul>${n.watchOut
            .map((w) => `<li>${ICON.alert}<span>${esc(w)}</span></li>`)
            .join('')}</ul></div>`
        : '';
    const ev =
      n && (n.evidence || []).length
        ? `<div class="evidence"><span class="lbl">Evidence used</span>${n.evidence
            .map((e) => `<span class="chip">${esc(e)}</span>`)
            .join('')}</div>`
        : '';
    const err =
      narration && narration.state === 'error'
        ? `<p class="why">Description unavailable — ${esc(narration.reason)}</p>`
        : '';
    // Where the edges came from: a type-checking language server, or name matching.
    const src = ctx.sources;
    const foundBy = src
      ? src.callers === src.callees
        ? src.callers
        : `callers by ${src.callers}, calls by ${src.callees}`
      : '';
    const tests = ctx.tests.count
      ? `${ctx.tests.count} test file${ctx.tests.count === 1 ? '' : 's'} reference this`
      : 'No test file references this';

    return `${watch}${err}${rows
      .map((r) => `<p class="line"><span class="k">${esc(r[0])}</span>${esc(r[1])}</p>`)
      .join('')}<p class="line"><span class="k">Tests</span>${esc(tests)}</p>
      ${authorsRow(ctx)}
      ${foundBy ? `<p class="line"><span class="k">Found by</span><span>${esc(foundBy)}</span></p>` : ''}
      <p class="line"><span class="k">As of commit</span><span><span class="mono">${esc(ctx.indexedAt)}</span>${ctx.dirty ? ' · plus unsaved edits' : ''}</span></p>${ev}`;
  }

  /* Who wrote it: one line per person, most lines first. */
  function authorsRow(ctx) {
    const all = ctx.authors || [];
    if (!all.length && !ctx.uncommittedLines) {
      return '';
    }
    const total = all.reduce((n, a) => n + a.lines, 0) + (ctx.uncommittedLines || 0);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const describe = (a) => {
      const bits = [];
      if (a.created) {
        bits.push('created it');
      }
      if (a.lines) {
        bits.push(all.length > 1 || ctx.uncommittedLines ? `${a.lines} of ${total} lines` : 'all current lines');
      } else {
        bits.push('none of the current lines');
      }
      if (a.commits) {
        bits.push(plural(a.commits, 'change'));
      }
      return bits.join(' · ');
    };
    const shown = all.slice(0, 5);
    const items = shown
      .map((a) => `<li><span class="aname">${esc(a.name)}</span><span class="ameta">${esc(describe(a))}</span></li>`)
      .join('');
    const more = all.length > shown.length ? `<li class="ameta">+${all.length - shown.length} more</li>` : '';
    const mine = ctx.uncommittedLines
      ? `<li><span class="aname">Uncommitted edits</span><span class="ameta">${ctx.uncommittedLines} of ${total} lines</span></li>`
      : '';
    const label = all.length > 1 ? 'Authors' : 'Author';
    return `<div class="line"><span class="k">${label}</span><ul class="authors">${items}${more}${mine}</ul></div>`;
  }

  /* ------------------------------------------------------------- plumbing */

  /* Step kinds collapse to four colours a reader can learn at a glance. */
  const KIND_CLASS = {
    read: 'k-read',
    filter: 'k-read',
    call: 'k-read',
    write: 'k-write',
    error: 'k-error',
    return: 'k-return',
    compute: 'k-flow',
    loop: 'k-flow',
    branch: 'k-flow',
    guard: 'k-flow'
  };
  const KEY = [
    ['k-read', 'reads or calls'],
    ['k-write', 'changes data'],
    ['k-error', 'can fail'],
    ['k-return', 'returns']
  ];

  const KIND_BADGE = { task: 'JOB', schedule: 'CRON', cli: 'CLI', event: 'EVENT', signal: 'SIGNAL', rpc: 'RPC' };
  const METHOD_CLASS = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' };

  const ICON = {
    refresh: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M13.45 5.17A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-.9-2.7L9.5 7.5H14V3l-.55 2.17z"/></svg>`,
    chevron: `<svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6 3.5 10.5 8 6 12.5"/></svg>`,
    alert: `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M8 2.2 14.4 13.5H1.6z"/><path stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M8 6.6v3.3M8 11.7v.1"/></svg>`
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthYear(iso) {
    const [y, m] = String(iso).slice(0, 10).split('-');
    return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : String(iso).slice(0, 10);
  }
  function dayMonthYear(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return MONTHS[Number(m) - 1] ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : String(iso).slice(0, 10);
  }

  function wire() {
    root.querySelectorAll('[data-file]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({
          type: 'navigate',
          file: el.getAttribute('data-file'),
          line: Number(el.getAttribute('data-line'))
        });
      })
    );
    root.querySelectorAll('[data-every-step]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        everyStep = !everyStep;
        render(lastCtx);
      })
    );
    root.querySelectorAll('[data-expand]').forEach((el) =>
      el.addEventListener('click', () => el.closest('ol').classList.add('all'))
    );
    root.querySelectorAll('[data-sha]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'commit', sha: el.getAttribute('data-sha') });
      })
    );
    const again = root.querySelector('#reanalyse');
    const reanalyse = (ev) => {
      ev.stopPropagation();
      if (spinning) {
        return;
      }
      spinning = true;
      stale = false;
      if (lastCtx) {
        render(lastCtx);
      }
      vscode.postMessage({ type: 'reanalyse' });
    };
    if (again) {
      again.addEventListener('click', reanalyse);
    }
    root.querySelectorAll('[data-retry]').forEach((el) => el.addEventListener('click', reanalyse));
    const aiswitch = root.querySelector('#aiswitch');
    if (aiswitch) {
      aiswitch.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'toggleAi' });
      });
    }
    root.querySelectorAll('[data-setup]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'setupAi' });
      })
    );
    const bar = root.querySelector('#stalebar');
    if (bar) {
      bar.addEventListener('click', reanalyse);
    }
    root.querySelectorAll('details[data-sec]').forEach((el) =>
      el.addEventListener('toggle', () => {
        open[el.getAttribute('data-sec')] = el.open;
        persist();
        requestAnimationFrame(syncPulse);
      })
    );
  }

  /**
   * Every "still working" pulse breathes in step. A CSS animation starts when
   * its element appears, so the headline, a section opened a second later and
   * one re-rendered by the next update would each be at a different point in
   * the cycle. Pinning them all to the same start time lines them up.
   */
  function syncPulse() {
    if (!document.getAnimations) {
      return;
    }
    for (const a of document.getAnimations()) {
      if (a.animationName === 'ccbreathe') {
        a.startTime = 0;
      }
    }
  }

  /**
   * "claude-haiku-4-5" → "Haiku 4.5"; "gemini-3.6-flash" → "Gemini 3.6 Flash";
   * "copilot/gpt-4o" → "GPT-4o via Copilot". Editor models name their vendor,
   * so the fallback from a missing key to Copilot is visible rather than silent.
   */
  function shortModel(id) {
    if (!id) {
      return 'AI';
    }
    const [vendor, family] = String(id).includes('/') ? String(id).split('/') : ['', String(id)];
    const words = family
      .replace(/^claude-/, '')
      .replace(/-latest$/, '')
      .replace(/(\d)-(\d)/g, '$1.$2')
      .split('-')
      .map((w) => (/^gpt$/i.test(w) ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)));
    const name = words.join(' ').replace(/^GPT (\S)/, 'GPT-$1');
    return vendor ? `${name} via ${vendor.charAt(0).toUpperCase() + vendor.slice(1)}` : name;
  }

  function shortFile(p) {
    const parts = String(p).split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();

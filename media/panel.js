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

  /** Boxes per row before the rest collapse into "+N more". Two fit a sidebar legibly. */
  const MAX_NODES = 2;
  let narration = null;
  let lastCtx = null;
  let open = { steps: false, history: false, touches: false, evidence: false };
  /** Set the moment the button is pressed, before the extension has replied. */
  let spinning = false;
  /** The function's code changed after this was analysed. */
  let stale = false;

  const saved = vscode.getState();
  if (saved) {
    lastCtx = saved.ctx || null;
    narration = saved.narration || null;
    open = Object.assign(open, saved.open || {});
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

  function persist() {
    vscode.setState({ ctx: lastCtx, narration, open, stale });
  }

  function render(ctx) {
    persist();
    root.innerHTML = [headline(ctx), journey(ctx), stats(ctx), sections(ctx)].join('');
    wire(ctx);
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
      <span class="aitag">AI is analysing</span>
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
    const ident = `<div class="ident">
      <div class="names">
        <div class="sym">${esc(ctx.symbol.qualified)}()</div>
        <div class="loc">${esc(ctx.symbol.file)} · line ${ctx.symbol.startLine + 1}${edited}</div>
      </div>
      <button class="iconbtn reanalyse${busy ? ' busy' : ''}${stale && !busy ? ' stale' : ''}" id="reanalyse"
              title="Re-analyse" aria-label="Re-analyse this function"${busy ? ' disabled' : ''}>${ICON.refresh}</button>
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
      return `${ident}${staleBar}<div class="ai pending"><p class="lead">${esc(note)}</p></div>`;
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
   * The journey strip: from the outside world to this function.
   *
   * A route, then the handler it lands in, then this function. It shows the
   * first way in; the rest are one click away. Functions nobody reaches from a
   * route, job or command simply don't get a strip.
   */
  function journey(ctx) {
    const entries = ctx.isEntryPoint ? [ctx.isEntryPoint] : ctx.reachedFrom || [];
    if (!entries.length) {
      return '';
    }
    const [first, ...rest] = entries;
    const handler = first.symbol;
    const direct = ctx.isEntryPoint || handler.qualified === ctx.symbol.qualified;
    const rows = [
      entryRow(first),
      direct
        ? ''
        : `<div class="jrow hit" data-file="${esc(handler.file)}" data-line="${handler.line}" title="${esc(handler.file)}">
             <span class="jfn">${esc(handler.name)}()</span><span class="jnote">handler</span>
           </div>`,
      `<div class="jrow here"><span class="jfn">${esc(ctx.symbol.name)}()</span><span class="jnote">this function</span></div>`
    ].join('');
    const more = rest.length
      ? `<details class="jmore"><summary>+${rest.length} more way${rest.length === 1 ? '' : 's'} in</summary>${rest
          .map(entryRow)
          .join('')}</details>`
      : '';
    return `<div class="journey">${rows}${more}</div>`;
  }

  function entryRow(e) {
    const http = e.kind === 'http' ? /^([A-Z]+(?:\/[A-Z]+)*)\s+(.+)$/.exec(e.label) : null;
    const badge = http
      ? `<span class="method m-${METHOD_CLASS[http[1].split('/')[0]] || 'other'}">${esc(http[1])}</span>`
      : `<span class="method m-other">${esc(KIND_BADGE[e.kind] || e.kind)}</span>`;
    const text = http ? http[2] : e.label.replace(/^(background job|scheduled|command):\s*/, '');
    return `<div class="jrow hit" data-file="${esc(e.symbol.file)}" data-line="${e.symbol.line}"
                 title="${esc(e.label)}${e.detail ? ' · ' + esc(e.detail) : ''}">
      ${badge}<span class="jpath">${esc(text)}</span>
    </div>`;
  }

  /** The numbers worth knowing, in one quiet line. Nothing is repeated below. */
  function stats(ctx) {
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
    const ai = ctx.history.filter((h) => h.aiAssisted).length;
    if (ai) {
      bits.push(`<span class="bad">${ai} AI-assisted</span>`);
    }
    return `<div class="stats">${bits.map((b) => `<span>${b}</span>`).join('')}</div>`;
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
      error: 'can fail',
      return: 'returns',
      guard: 'checks'
    };
    const shape = w.steps
      .map((st) => WORD[st.kind])
      .filter((v, i, a) => v && a.indexOf(v) === i)
      .slice(0, 3)
      .join(', ');
    return `${w.steps.length} step${w.steps.length === 1 ? '' : 's'} · ${shape}`;
  }

  function stepsBody(ctx) {
    const w = ctx.workflow;
    if (!w || (!w.steps.length && !w.requires.length)) {
      return '';
    }
    const plain =
      narration && narration.state === 'ready' && (narration.steps || []).length === w.steps.length
        ? narration.steps
        : [];
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

    const steps = w.steps
      .map(
        (st, i) => `<li class="hit" data-file="${esc(ctx.symbol.file)}" data-line="${st.line}"
                        title="Step ${i + 1} · line ${st.line + 1}">
          <span class="dot ${KIND_CLASS[st.kind] || 'k-flow'}"></span>
          <span class="txt">${esc(plain[i] || st.label)}</span>
        </li>`
      )
      .join('');
    // Only the colours actually used get a key, so a function that never
    // writes doesn't carry a "changes data" entry nobody needs to learn.
    const used = new Set(w.steps.map((st) => KIND_CLASS[st.kind]).filter(Boolean));
    const key = KEY.filter(([cls]) => used.has(cls));
    const keyHtml = key.length
      ? `<div class="key">${key.map(([cls, word]) => `<span class="${cls}">${esc(word)}</span>`).join('')}</div>`
      : '';

    const body = `${meta}${steps ? `<ol class="tl">${steps}</ol>` : ''}${keyHtml}`;
    const pending = aiPending('unpacking the steps…');
    if (pending) {
      return `${pending}${body}`;
    }
    // Same rule as the headline block: if a model wrote the words, the amber
    // rule marks them. The step numbers and order are still computed.
    return plain.length || needs
      ? `<div class="ai-inline"><span class="aitag">In plain language</span>${body}</div>`
      : body;
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
      items.length > MAX_NODES
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
   * below — every box is a jump. Reading the shape is the point; the lists under
   * it only appear when there are too many boxes to draw.
   */
  function mapSvg(ctx, callers, calls) {
    const W = 352;
    const BOX_H = 38;
    const GAP = 8;

    const up = callers.slice(0, MAX_NODES);
    const upHidden = callers.length - up.length;
    const down = calls.slice(0, MAX_NODES);
    const downHidden = calls.length - down.length;

    const hasUp = up.length || upHidden;
    const hasDown = down.length || downHidden;

    const yUp = 4;
    const yFocus = hasUp ? 78 : 4;
    const yDown = yFocus + 82;
    const H = hasDown ? yDown + BOX_H + 4 : yFocus + 48;

    const row = (nodes, hidden, y) => {
      const count = nodes.length + (hidden > 0 ? 1 : 0);
      if (!count) {
        return { boxes: [], svg: '' };
      }
      const w = (W - GAP * (count - 1)) / count;
      const boxes = nodes.map((n, i) => ({ x: i * (w + GAP), w, node: n }));
      if (hidden > 0) {
        boxes.push({ x: nodes.length * (w + GAP), w, node: null, label: `+${hidden} more` });
      }
      const svg = boxes
        .map((b) => {
          const n = b.node;
          const dashed = n && n.confidence !== 'resolved';
          const nav = n
            ? ` class="hit" data-file="${esc(n.file)}" data-line="${n.line}"`
            : ' class="dim"';
          const label = n ? n.name : b.label;
          const sub = n ? String(n.file).split('/').pop() : 'listed below';
          return `<g${nav}>
            <rect x="${b.x}" y="${y}" width="${b.w}" height="${BOX_H}" rx="6"
              fill="var(--cc-card)" stroke="${dashed ? 'var(--cc-red)' : 'var(--cc-line)'}"
              ${dashed ? 'stroke-dasharray="3 3"' : ''}/>
            <text x="${b.x + 9}" y="${y + 16}" font-size="11" fill="var(--cc-link)">${esc(
              clip(label, Math.floor((b.w - 14) / 6.7))
            )}</text>
            <text x="${b.x + 9}" y="${y + 30}" font-size="9.5" fill="var(--cc-dim)">${esc(
              clip(sub, Math.floor((b.w - 14) / 5.8))
            )}</text>
          </g>`;
        })
        .join('');
      return { boxes, svg };
    };

    const upRow = row(up, upHidden, yUp);
    const downRow = row(down, downHidden, yDown);
    const focusX = 48;
    const focusW = W - focusX * 2;

    const anchors = (n) => {
      if (!n) {
        return [];
      }
      const span = focusW * 0.6;
      const left = W / 2 - span / 2;
      return n === 1 ? [W / 2] : Array.from({ length: n }, (_, i) => left + (span / (n - 1)) * i);
    };
    const upA = anchors(upRow.boxes.length);
    const downA = anchors(downRow.boxes.length);

    const edge = (x1, y1, x2, y2, dashed) => {
      const mid = (y1 + y2) / 2;
      return `<path d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" fill="none"
        stroke="${dashed ? 'var(--cc-red)' : 'var(--cc-dim)'}" stroke-width="1"
        ${dashed ? 'stroke-dasharray="3 3"' : ''} opacity=".8" marker-end="url(#cc-ah)"/>`;
    };

    return `<svg viewBox="0 0 ${W} ${H}" class="map" role="img">
      <defs><marker id="cc-ah" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="var(--cc-dim)"/></marker></defs>
      ${upRow.boxes
        .map((b, i) =>
          edge(b.x + b.w / 2, yUp + BOX_H, upA[i], yFocus, b.node && b.node.confidence !== 'resolved')
        )
        .join('')}
      ${upRow.svg}
      <rect x="${focusX}" y="${yFocus}" width="${focusW}" height="40" rx="7"
        fill="var(--cc-card)" stroke="var(--cc-acc)" stroke-width="1.5"/>
      <text x="${W / 2}" y="${yFocus + 18}" text-anchor="middle" font-size="12"
        fill="var(--vscode-foreground)">${esc(clip(ctx.symbol.name + '()', Math.floor(focusW / 7.3)))}</text>
      <text x="${W / 2}" y="${yFocus + 31}" text-anchor="middle" font-size="10"
        fill="var(--cc-acc)" style="font-family: var(--vscode-font-family)">this function</text>
      ${downRow.boxes
        .map((b, i) =>
          edge(downA[i], yFocus + 42, b.x + b.w / 2, yDown, b.node && b.node.confidence !== 'resolved')
        )
        .join('')}
      ${downRow.svg}
    </svg>`;
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
    const tests = ctx.tests.count
      ? `${ctx.tests.count} test file${ctx.tests.count === 1 ? '' : 's'} reference this`
      : 'No test file references this';

    return `${watch}${err}${rows
      .map((r) => `<p class="line"><span class="k">${esc(r[0])}</span>${esc(r[1])}</p>`)
      .join('')}<p class="line"><span class="k">Tests</span>${esc(tests)}</p>
      <p class="line"><span class="k">As of commit</span><span><span class="mono">${esc(ctx.indexedAt)}</span>${ctx.dirty ? ' · plus unsaved edits' : ''}</span></p>${ev}`;
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

  const KIND_BADGE = { task: 'JOB', schedule: 'CRON', cli: 'CLI', event: 'EVENT', signal: 'SIGNAL' };
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
    const bar = root.querySelector('#stalebar');
    if (bar) {
      bar.addEventListener('click', reanalyse);
    }
    root.querySelectorAll('details[data-sec]').forEach((el) =>
      el.addEventListener('toggle', () => {
        open[el.getAttribute('data-sec')] = el.open;
        persist();
      })
    );
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

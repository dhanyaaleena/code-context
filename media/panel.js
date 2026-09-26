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

  const MAX_NODES = 3;
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
    root.innerHTML = [headline(ctx), badges(ctx), wayIn(ctx), sections(ctx)].join('');
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
      <span class="aitag">AI · analysing</span>
      <p class="why" style="margin:0">${esc(what)}</p>
    </div>`;
  }

  /* ------------------------------------------------------------- the glance */

  function headline(ctx) {
    const n = narration && narration.state === 'ready' ? narration : null;
    const edited = ctx.dirty
      ? `<span class="fresh dirty">EDITED SINCE ${esc(ctx.indexedAt)}</span>`
      : '';

    // Computed identity sits outside the amber rule; everything inside it was
    // written by the model. Keeping that boundary visible is the trust mechanism,
    // so it survives even when there is no narration to put in it.
    const busy = spinning || (narration && narration.state === 'loading');
    const ident = `<div class="ident">
      <span class="sym">${esc(ctx.symbol.qualified)}()</span>
      <span class="loc">${esc(shortFile(ctx.symbol.file))}:${ctx.symbol.startLine + 1}</span>
      ${edited}
      <button class="reanalyse${busy ? ' busy' : ''}${stale && !busy ? ' stale' : ''}" id="reanalyse"
              title="Re-analyse" aria-label="Re-analyse this function"${busy ? ' disabled' : ''}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path fill="currentColor" d="M13.45 5.17A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-.9-2.7L9.5 7.5H14V3l-.55 2.17z"/>
        </svg>
      </button>
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
      <div class="airow">
        <span class="feat">${esc(n.featureName)}</span>
        <span class="src">${esc(shortModel(n.model))}${n.cached ? ' · cached' : ''}</span>
      </div>
      <p class="lead">${esc(n.headline)}</p>
      ${n.risk ? `<p class="line"><span class="k">If it breaks</span>${esc(n.risk)}</p>` : ''}
    </div>`;
  }

  /** Nothing renders when there is nothing to warn about. */
  function badges(ctx) {
    const out = [];
    // "untested" and the guessed-edge count both moved out of the badge row:
    // the first is already in Detail, the second is already drawn as the dashed
    // edges in the map, and repeating them here cost a line at the top of a
    // panel whose whole point is the ten-second read.
    const ai = ctx.history.filter((h) => h.aiAssisted).length;
    if (ai) {
      out.push(['warn', `${ai} AI-assisted change${ai === 1 ? '' : 's'}`]);
    }
    const ways = (ctx.reachedFrom || []).length;
    if (ways > 3) {
      out.push(['', `${ways} ways in`]);
    }
    if (ctx.impact.direct > 8) {
      out.push(['', `${ctx.impact.direct} callers`]);
    }
    if (!out.length) {
      return '';
    }
    return `<div class="badges">${out
      .map(([cls, t]) => `<span class="badge ${cls}">${esc(t)}</span>`)
      .join('')}</div>`;
  }

  function wayIn(ctx) {
    const all = ctx.isEntryPoint ? [ctx.isEntryPoint] : ctx.reachedFrom || [];
    if (!all.length) {
      return '';
    }
    const first = all[0];
    const more = all.length - 1;
    return `<div class="wayin hit" data-file="${esc(first.symbol.file)}" data-line="${first.symbol.line}">
      <span class="k">${esc(KIND_WORD[first.kind] || first.kind)}</span>
      <span class="v">${esc(first.label)}</span>
      ${more ? `<span class="more-n">+${more}</span>` : ''}
    </div>`;
  }

  /* ---------------------------------------------------------- the disclosures */

  function sections(ctx) {
    return [
      section('steps', 'What it does', stepsSummary(ctx), stepsBody(ctx)),
      section('history', 'How it got here', historySummary(ctx), historyBody(ctx)),
      section('touches', 'What it touches', touchesSummary(ctx), touchesBody(ctx)),
      section('evidence', 'Detail', 'the longer version', detailBody(ctx))
    ]
      .filter(Boolean)
      .join('');
  }

  function section(id, title, summary, body) {
    if (!body) {
      return '';
    }
    return `<details class="sec" data-sec="${id}"${open[id] ? ' open' : ''}>
      <summary><span class="t">${esc(title)}</span><span class="s">${esc(summary)}</span></summary>
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
    return `${w.steps.length} steps — ${shape}`;
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
            ? `<div class="wmeta"><span class="k">NEEDS</span>${w.requires
                .map((r) => `<span class="chip dim">${esc(r)}</span>`)
                .join('')}</div>`
            : '',
          w.inputs.length
            ? `<div class="wmeta"><span class="k">TAKES</span>${w.inputs
                .map((i) => `<span class="chip dim">${esc(i.name)}</span>`)
                .join('')}</div>`
            : ''
        ].join('');

    const steps = w.steps
      .map(
        (st, i) => `<li class="wstep hit" data-file="${esc(ctx.symbol.file)}" data-line="${st.line}">
          <span class="wnum" style="color:${STEP_COLOUR[st.kind] || 'var(--cc-dim)'};
                border-color:${STEP_COLOUR[st.kind] || 'var(--cc-line)'}">${i + 1}</span>
          <span class="wlabel">${esc(plain[i] || st.label)}</span>
        </li>`
      )
      .join('');

    const body = `${meta}${steps ? `<ol class="wsteps">${steps}</ol>` : ''}`;
    const pending = aiPending('unpacking the steps…');
    if (pending) {
      return `${pending}${body}`;
    }
    // Same rule as the headline block: if a model wrote the words, the amber
    // rule marks them. The step numbers and order are still computed.
    return plain.length || needs
      ? `<div class="ai-inline"><span class="aitag">AI · plain language</span>${body}</div>`
      : body;
  }

  /* -- how it got here -- */

  function historySummary(ctx) {
    if (!ctx.history.length) {
      return 'no git history';
    }
    const n = ctx.history.length + (ctx.historyOlder || 0);
    const last = ctx.history[ctx.history.length - 1];
    return `${n} change${n === 1 ? '' : 's'}, latest ${last.date.slice(0, 10)}`;
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
        (h) => `<li class="hrow hit" data-sha="${esc(h.sha)}">
          <span class="hdate">${esc(h.date.slice(0, 10))}</span>
          <span class="hsub${h.aiAssisted ? ' ai' : ''}">${esc(h.subject)}${
            h.origin ? '<span class="origin">added here</span>' : ''
          }</span>
        </li>`
      )
      .join('');
    const co = ctx.feature.coChange.length
      ? `<div class="wmeta" style="margin-top:9px"><span class="k">CHANGES WITH</span>${ctx.feature.coChange
          .map((c) => `<span class="chip dim">${esc(shortFile(c.file))} ×${c.commits}</span>`)
          .join('')}</div>`
      : '';
    const older = ctx.historyOlder
      ? `<p class="olderline">+${ctx.historyOlder} older change${ctx.historyOlder === 1 ? '' : 's'}</p>`
      : '';
    return `${why}<ul class="hlist">${rows}${older ? '' : ''}</ul>${older}${co}`;
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
    const tag =
      narration.originBasis === 'inferred' ? 'AI · why it exists · inferred' : 'AI · why it exists';
    return `<div class="ai-inline"><span class="aitag">${esc(tag)}</span>
      ${origin ? `<p class="why" style="margin:0">${esc(origin)}</p>` : ''}
      ${since ? `<p class="why since">${esc(since)}</p>` : ''}
    </div>`;
  }

  /* -- what it touches -- */

  function ownCalls(ctx) {
    return ctx.callees.filter((c) => c.confidence !== 'external' && c.confidence !== 'unresolved');
  }

  function touchesSummary(ctx) {
    const calls = ownCalls(ctx).length;
    const callers = ctx.callers.length;
    const bits = [];
    if (callers) {
      bits.push(`${callers} caller${callers === 1 ? '' : 's'}`);
    }
    if (calls) {
      bits.push(`${calls} call${calls === 1 ? '' : 's'}`);
    }
    if (ctx.impact.transitive) {
      bits.push(`${ctx.impact.transitive} further out`);
    }
    return bits.join(' · ') || 'nothing in this workspace';
  }

  function touchesBody(ctx) {
    const calls = ownCalls(ctx);
    if (!calls.length && !ctx.callers.length) {
      return '';
    }
    const upstreamCovered =
      ctx.callers.length > 0 && (ctx.reachedFrom || []).length >= ctx.callers.length;
    const callers = upstreamCovered ? [] : ctx.callers;

    const list = (title, items) =>
      items.length > MAX_NODES
        ? `<details class="more"><summary>${esc(title)} — all ${items.length}</summary><ul>${items
            .map(
              (c) => `<li class="hit" data-file="${esc(c.file)}" data-line="${c.line}">
                <b>${esc(c.qualified)}</b>
                <span class="why">${esc(shortFile(c.file))}${
                  c.confidence !== 'resolved' ? ` · ${esc(c.confidence)}` : ''
                }</span></li>`
            )
            .join('')}</ul></details>`
        : '';

    return `${mapSvg(ctx, callers, calls)}
      <div class="legend"><span><i></i>resolved</span><span><i class="d"></i>a guess</span>
        <span class="hint">click a box to jump there</span></div>
      ${list('Called by', callers)}${list('Calls', calls)}`;
  }

  /**
   * The navigable map. Callers above, this symbol in the middle, what it calls
   * below — every box is a jump. Reading the shape is the point; the lists under
   * it only appear when there are too many boxes to draw.
   */
  function mapSvg(ctx, callers, calls) {
    const W = 512;
    const BOX_H = 34;
    const GAP = 12;

    const up = callers.slice(0, MAX_NODES);
    const upHidden = callers.length - up.length;
    const down = calls.slice(0, MAX_NODES);
    const downHidden = calls.length - down.length;

    const hasUp = up.length || upHidden;
    const hasDown = down.length || downHidden;

    const yUp = 18;
    const yFocus = hasUp ? 104 : 22;
    const yDown = yFocus + 88;
    const H = hasDown ? yDown + BOX_H + 8 : yFocus + 56;

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
          const sub = n ? shortFile(n.file) : 'in the list below';
          return `<g${nav}>
            <rect x="${b.x}" y="${y}" width="${b.w}" height="${BOX_H}" rx="6"
              fill="var(--cc-card)" stroke="${dashed ? 'var(--cc-red)' : 'var(--cc-line)'}"
              ${dashed ? 'stroke-dasharray="3 3"' : ''}/>
            <text x="${b.x + 9}" y="${y + 15}" font-size="10.5" fill="var(--cc-link)">${esc(
              clip(label, Math.floor(b.w / 6))
            )}</text>
            <text x="${b.x + 9}" y="${y + 27}" font-size="8.5" fill="var(--cc-dim)">${esc(
              clip(sub, Math.floor(b.w / 5))
            )}</text>
          </g>`;
        })
        .join('');
      return { boxes, svg };
    };

    const upRow = row(up, upHidden, yUp);
    const downRow = row(down, downHidden, yDown);
    const focusX = 86;
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
      <rect x="${focusX}" y="${yFocus}" width="${focusW}" height="42" rx="7"
        fill="var(--cc-card)" stroke="var(--cc-acc)" stroke-width="1.5"/>
      <text x="${W / 2}" y="${yFocus + 19}" text-anchor="middle" font-size="12"
        fill="var(--vscode-foreground)">${esc(clip(ctx.symbol.qualified + '()', 40))}</text>
      <text x="${W / 2}" y="${yFocus + 32}" text-anchor="middle" font-size="8"
        letter-spacing="1.1" fill="var(--cc-acc)">YOU ARE HERE</text>
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

  function detailBody(ctx) {
    const n = narration && narration.state === 'ready' ? narration : null;
    const rows = [];
    if (n && n.flow) {
      rows.push(['How it is reached', n.flow]);
    }
    if (!n) {
      rows.push(['Computed summary', ctx.summary]);
    }
    const watch =
      n && (n.watchOut || []).length
        ? `<div class="watch"><div class="wt">WATCH OUT</div><ul>${n.watchOut
            .map((w) => `<li>${esc(w)}</li>`)
            .join('')}</ul></div>`
        : '';
    const ev =
      n && (n.evidence || []).length
        ? `<div class="wmeta" style="margin-top:10px"><span class="k">EVIDENCE</span>${n.evidence
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

    return `${err}${rows
      .map((r) => `<p class="line"><span class="k">${esc(r[0])}</span>${esc(r[1])}</p>`)
      .join('')}${watch}<p class="line"><span class="k">Tests</span>${esc(tests)}</p>
      <p class="line"><span class="k">Indexed</span>${esc(ctx.indexedAt)}${ctx.dirty ? ' · buffer is ahead' : ''}</p>${ev}`;
  }

  /* ------------------------------------------------------------- plumbing */

  const KIND_WORD = {
    http: 'web request',
    task: 'background job',
    schedule: 'scheduled job',
    cli: 'command line',
    event: 'app event',
    signal: 'app signal'
  };

  const STEP_COLOUR = {
    read: 'var(--cc-link)',
    filter: 'var(--cc-link)',
    compute: 'var(--vscode-foreground)',
    loop: 'var(--vscode-foreground)',
    call: 'var(--cc-link)',
    branch: 'var(--cc-warn)',
    write: 'var(--cc-warn)',
    error: 'var(--cc-red)',
    return: 'var(--cc-acc)',
    guard: 'var(--cc-dim)'
  };

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

  function shortModel(id) {
    if (!id) {
      return 'AI';
    }
    // Editor models arrive as vendor/family — say who is answering, so the
    // fallback from a missing key to Copilot is visible rather than silent.
    const [vendor, family] = String(id).includes('/') ? String(id).split('/') : ['', String(id)];
    const short = family.replace(/^claude-/, '').replace(/-latest$/, '').replace(/-/g, ' ');
    return vendor ? `${short} via ${vendor}` : short;
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

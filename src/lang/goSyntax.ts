/**
 * Go syntax helpers shared by the Go pack, its step extractor and its entry-point
 * scanner. Kept apart so those modules don't import each other in a cycle.
 */

/**
 * The text with string contents, rune literals and comments blanked out, every
 * offset preserved. Brace matching and call extraction run on this, so a `}` in
 * a string or a commented-out call can't mislead them.
 */
export function maskGo(text: string): string {
  const out = text.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === '\'') {
      let k = i + 1;
      while (k < text.length && text[k] !== c && text[k] !== '\n') {
        k += text[k] === '\\' ? 2 : 1;
      }
      blank(i + 1, k); // keep the quotes, so `"..."` still reads as a literal
      i = k + 1;
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end === -1 ? text.length : end;
      blank(i + 1, stop);
      i = stop + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** `import alias "path"` in all its forms, as alias → import path. */
export function goImports(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (alias: string | undefined, path: string) => {
    if (alias === '_' || alias === '.') {
      return;
    }
    const segs = path.split('/');
    let last = segs[segs.length - 1];
    if (/^v\d+$/.test(last) && segs.length > 1) {
      last = segs[segs.length - 2]; // github.com/go-chi/chi/v5 is imported as chi
    }
    out.set(alias ?? last.replace(/\.v\d+$/, '').replace(/^go-/, ''), path);
  };
  const single = /^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = single.exec(text))) {
    add(m[1], m[2]);
  }
  const block = /^\s*import\s*\(([\s\S]*?)^\s*\)/gm;
  while ((m = block.exec(text))) {
    for (const line of m[1].split('\n')) {
      const spec = /^\s*(?:([\w.]+)\s+)?"([^"]+)"/.exec(line);
      if (spec) {
        add(spec[1], spec[2]);
      }
    }
  }
  return out;
}

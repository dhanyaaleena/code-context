import { go } from './go';
import { python } from './python';
import { LanguagePack } from './types';

/**
 * The installed language packs. Adding a language means adding it here — the
 * index, the panel and the language-server layer pick it up from this list.
 *
 * Languages without a pack still get a panel wherever the editor has a language
 * server for them: callers, callees, the map and history work through the
 * server; steps and the journey need a pack.
 */
export const PACKS: LanguagePack[] = [python, go];

export function packForPath(path: string): LanguagePack | undefined {
  const lower = path.toLowerCase();
  return PACKS.find((p) => p.extensions.some((ext) => lower.endsWith(ext)));
}

export function packForLanguage(languageId: string): LanguagePack | undefined {
  return PACKS.find((p) => p.languageIds.includes(languageId));
}

/** `**\/*.{py,go}` — every file a pack can read. */
export function packGlob(): string {
  const exts = PACKS.flatMap((p) => p.extensions.map((e) => e.slice(1)));
  return exts.length === 1 ? `**/*.${exts[0]}` : `**/*.{${exts.join(',')}}`;
}

/** Directories no pack wants indexed, plus the ones nobody does. */
export function excludeGlob(): string {
  const dirs = new Set(['node_modules', '.git', 'build', 'dist', ...PACKS.flatMap((p) => p.excludeDirs)]);
  return `**/{${[...dirs].join(',')}}/**`;
}

export type { LanguagePack } from './types';

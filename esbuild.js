// Bundles the extension into a single file. The editor loads one module
// instead of walking ~3,000 files in node_modules, and the published package
// drops from ~7 MB to about a megabyte.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'], // provided by the editor at runtime
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'warning'
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

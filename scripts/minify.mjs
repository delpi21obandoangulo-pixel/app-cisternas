// Minifica app.js / ui-fx.js / pwa.js -> *.min.js para el deploy (Vercel/PWA).
// Los .js originales quedan como fuente legible; index.html apunta a los .min.js.
// Correr: `node scripts/minify.mjs` tras cambiar cualquiera de esos 3 archivos.
import { build } from 'esbuild';
import { statSync } from 'node:fs';

const targets = [
  { in: 'app.js',   out: 'app.min.js' },
  { in: 'ui-fx.js', out: 'ui-fx.min.js' },
  { in: 'pwa.js',   out: 'pwa.min.js' },
];
const kb = f => (statSync(f).size / 1024).toFixed(1) + ' KB';

for (const t of targets) {
  await build({
    entryPoints: [t.in],
    outfile: t.out,
    minify: true,
    target: 'es2017',
    legalComments: 'none',
    charset: 'utf8',
  });
  console.log(`${t.in} (${kb(t.in)})  ->  ${t.out} (${kb(t.out)})`);
}

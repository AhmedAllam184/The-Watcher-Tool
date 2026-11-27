import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import config from './mobile-preview.config.mjs';

// Optional committed desktop baseline uses the original entry, markup and
// stylesheet, without a second checkout or writing the dependency junction.
const baseline = process.argv.includes('--baseline');
const baselineRef = '896871e';
const baselineFiles = ['src/ui/applicationShell.js', 'style.css', 'index.html'];
const plugin = {
  name: 'committed-mobile-baseline',
  enforce: 'pre',
  load(id) {
    const name = baselineFiles.find((file) =>
      id.replaceAll('\\', '/').endsWith('/' + file),
    );
    if (name)
      return execFileSync('git', ['show', baselineRef + ':' + name], {
        encoding: 'utf8',
      });
  },
  transformIndexHtml: {
    order: 'pre',
    handler: () =>
      execFileSync('git', ['show', baselineRef + ':index.html'], {
        encoding: 'utf8',
      }),
  },
};
await build({
  ...config,
  configFile: false,
  plugins: baseline ? [plugin, ...config.plugins] : config.plugins,
});

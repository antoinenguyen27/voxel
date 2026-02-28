import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist');

async function ensureDirs() {
  await fs.mkdir(path.join(outDir, 'background'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'sidepanel'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'content'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'lib'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'options'), { recursive: true });
}

async function copy(src, dst) {
  await fs.copyFile(path.join(root, src), path.join(outDir, dst));
}

function makeDistManifest(sourceManifest) {
  const manifest = JSON.parse(sourceManifest);
  manifest.background.service_worker = 'background/service-worker.js';
  if (manifest.side_panel?.default_path) {
    manifest.side_panel.default_path = 'sidepanel/panel.html';
  }
  manifest.content_scripts = [
    {
      ...manifest.content_scripts[0],
      js: ['content/bridge.js']
    }
  ];
  manifest.web_accessible_resources = [
    {
      ...manifest.web_accessible_resources[0],
      resources: ['content/capture.js', 'content/executor.js', 'lib/selector.js']
    }
  ];
  return JSON.stringify(manifest, null, 2);
}

async function run() {
  await ensureDirs();

  await build({
    entryPoints: ['background/service-worker.js'],
    bundle: true,
    format: 'esm',
    outfile: 'dist/background/service-worker.js',
    target: 'chrome120'
  });

  await build({
    entryPoints: ['sidepanel/panel.js'],
    bundle: true,
    format: 'iife',
    outfile: 'dist/sidepanel/panel.js',
    target: 'chrome120'
  });

  await copy('content/capture.js', 'content/capture.js');
  await copy('content/executor.js', 'content/executor.js');
  await copy('content/bridge.js', 'content/bridge.js');
  await copy('lib/selector.js', 'lib/selector.js');

  await copy('sidepanel/panel.html', 'sidepanel/panel.html');
  await copy('sidepanel/panel.css', 'sidepanel/panel.css');
  await copy('options/options.html', 'options/options.html');
  await copy('options/options.js', 'options/options.js');

  const manifestText = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  await fs.writeFile(path.join(outDir, 'manifest.json'), makeDistManifest(manifestText));
}

run().catch((err) => {
  console.error('[build] failed', err);
  process.exit(1);
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No credential values are copied into a worktree, prompt, manifest or evidence.
export function applicationLoginCommand({ config, session, socketDir, browserConfigFile, directory, feRepository }) {
  const manifest = join(directory, 'local-login.json');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(manifest, JSON.stringify({
    url: new URL('/login', config.url).href, session, socket_dir: socketDir, browser_config: browserConfigFile,
    credential_file: join(feRepository, '.ai-login.local.md'),
  }), { mode: 0o600 });
  return ['node', fileURLToPath(new URL('../browser-login.mjs', import.meta.url)), manifest];
}

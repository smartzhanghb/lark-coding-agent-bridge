#!/usr/bin/env node
// Read the existing authenticated local control plane. Never fall back to killing a process.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
const root = process.env.LARK_CHANNEL_HOME || join(homedir(), '.lark-channel');
try {
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  const ui = JSON.parse(await readFile(join(root, 'ui.json'), 'utf8'));
  const profile = process.argv[2] || config.activeProfile;
  const url = new URL(`/api/maintenance/restart-if-idle?profile=${encodeURIComponent(profile)}`, `http://127.0.0.1:${ui.port}`);
  const response = await fetch(url, { method: 'POST', headers: { 'x-ui-token': ui.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(JSON.stringify({ time: new Date().toISOString(), profile, ...result }));
} catch (err) {
  console.error(`定时维护未执行：${err.message}`);
  process.exitCode = 1;
}

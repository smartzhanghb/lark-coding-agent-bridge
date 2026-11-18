// Never let a developer's Claude menu / proxy change the regression fixtures.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, vi } from 'vitest';
const configDir = mkdtempSync(join(tmpdir(), 'bridge-test-claude-'));
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  for (const key of Object.keys(process.env)) if (key.startsWith('ANTHROPIC_') && (key.includes('MODEL') || key === 'ANTHROPIC_BASE_URL')) vi.stubEnv(key, undefined);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(configDir, { recursive: true, force: true }); });

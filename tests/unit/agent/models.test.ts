import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});

const modelRoots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of modelRoots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function modelSettings(settings: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-models-')); modelRoots.push(dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}
describe('Claude Code configured models', () => {
  it('uses exact custom ids and labels instead of Anthropic names, and refreshes edits', () => {
    const dir = modelSettings({ modelPicker: { replaceBuiltInOptions: true, options: [
      { model: 'ccs-glm[1M]', label: 'GLM' }, { model: 'ccs-kimi', label: 'Kimi' },
      { model: 'ccs-kimi', label: 'Kimi' }, { model: '--bad', label: 'bad' },
    ] } });
    expect(supportedModels('claude')).toEqual([{ value: 'default', label: '跟随默认（不指定）' }, { value: 'ccs-glm[1M]', label: 'GLM' }, { value: 'ccs-kimi', label: 'Kimi' }]);
    expect(resolveModelArg('claude', 'ccs-glm[1M]')).toBe('ccs-glm[1M]');
    expect(modelLabel('claude', 'ccs-kimi')).toBe('Kimi');
    expect(supportedModels('codex').some((m) => m.value === 'ccs-kimi')).toBe(false);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'new-glm', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: '新 GLM' } }));
    expect(supportedModels('claude').slice(1)).toEqual([{ value: 'new-glm', label: '新 GLM' }]);
  });
  it('never invents Anthropic choices for an unconfigured proxy or malformed file', () => {
    const dir = modelSettings({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' } });
    expect(supportedModels('claude').map((m) => m.value)).toEqual(['default']);
    writeFileSync(join(dir, 'settings.json'), '{invalid');
    expect(supportedModels('claude').map((m) => m.value)).toEqual(['default']);
  });
  it('reads project-local model menus without changing another workspace catalog', () => {
    modelSettings({ modelPicker: { options: [{ model: 'global-kimi', label: 'Kimi' }] } });
    const project = mkdtempSync(join(tmpdir(), 'bridge-model-project-')); modelRoots.push(project);
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ modelPicker: { options: [{ model: 'project-glm', label: 'GLM 项目' }] } }));
    expect(supportedModels('claude', project).map((m) => m.value)).toEqual(['default', 'project-glm']);
    expect(supportedModels('claude').map((m) => m.value)).toEqual(['default', 'global-kimi']);
  });
});

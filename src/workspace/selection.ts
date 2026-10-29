import type { WorkspaceStore } from './store';
import type { ProfileConfig } from '../config/profile-schema';
export function selectedWorkspace(input: { workspaces: WorkspaceStore; profileConfig: ProfileConfig; scope: string; ownerDm?: boolean }): string | undefined {
  if (!input.profileConfig.workspaces.managedBindings) return input.workspaces.cwdFor(input.scope) ?? input.profileConfig.workspaces.default;
  const selected = input.workspaces.selection(input.scope);
  if (selected.project) return selected.project.enabled ? selected.project.cwd : undefined;
  if (!input.workspaces.binding(input.scope) && input.ownerDm) return input.profileConfig.workspaces.default;
  return undefined;
}
export function selectedModel(input: { workspaces: WorkspaceStore; profileConfig: ProfileConfig; scope: string }): string | undefined {
  return (input.profileConfig.workspaces.managedBindings ? input.workspaces.selection(input.scope).project?.model : undefined) ?? input.profileConfig.preferences.model;
}
export function generationFingerprint(fingerprint: string, generation: string): string { return `${fingerprint}:generation=${generation}`; }
export function baseFingerprint(fingerprint: string): string { return fingerprint.split(':generation=')[0]!; }

import type { NormalizedMessage } from '@larksuite/channel';
const generations = new WeakMap<NormalizedMessage, string>();
export function stampWorkspaceMessage(message: NormalizedMessage, generation: string): void { generations.set(message, generation); }
export function workspaceMessageGeneration(message: NormalizedMessage): string | undefined { return generations.get(message); }

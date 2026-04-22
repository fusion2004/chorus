import { CompoAdminOnly } from '../preconditions/CompoAdminOnly.js';

export async function runCompoAdminOnly(interaction: any) {
  const ctx = {
    root: '',
    path: '',
    name: 'CompoAdminOnly',
    store: {} as any,
  };
  const precondition = new CompoAdminOnly(ctx as any, {} as any);
  return precondition.chatInputRun(interaction, {} as any, {} as any);
}

import { container } from '@sapphire/pieces';
import { Events } from '@sapphire/framework';
import { fakeClient } from '@test/helpers/sapphire.js';

export interface RunCommandResult {
  ran: boolean;
  blockedBy: string | null;
  deniedBy: any;
  emits: Array<[string | symbol, ...unknown[]]>;
}

// Drives a command through Sapphire's real event pipeline:
//   CorePreChatInputCommandRun.run(payload)
//     -> runs global + command preconditions (real PreconditionContainerArray
//        → PreconditionContainerSingle → container.stores.get('preconditions'))
//     -> emits ChatInputCommandDenied OR ChatInputCommandAccepted
//   CoreChatInputCommandAccepted.run(payload)
//     -> calls command.chatInputRun, emits Run/Success/Error/Finish
//
// The emits aren't dispatched to subscribed listeners (fakeClient.emit only
// captures), so we invoke the accepted listener ourselves on success.
export async function runCommand(command: any, interaction: any): Promise<RunCommandResult> {
  fakeClient.clearEmits();
  const payload = { command, interaction, context: {} };

  const preRun = container.stores.get('listeners').get('CorePreChatInputCommandRun') as any;
  await preRun.run(payload);

  const denied = fakeClient.emits.find((e) => e[0] === Events.ChatInputCommandDenied);
  if (denied) {
    const err = denied[1] as any;
    return {
      ran: false,
      blockedBy: err?.precondition?.name ?? null,
      deniedBy: err,
      emits: [...fakeClient.emits],
    };
  }

  const accepted = fakeClient.emits.find((e) => e[0] === Events.ChatInputCommandAccepted);
  if (accepted) {
    const listener = container.stores.get('listeners').get('CoreChatInputCommandAccepted') as any;
    await listener.run(accepted[1]);
    return {
      ran: true,
      blockedBy: null,
      deniedBy: null,
      emits: [...fakeClient.emits],
    };
  }

  return { ran: false, blockedBy: null, deniedBy: null, emits: [...fakeClient.emits] };
}

import { container } from '@sapphire/pieces';
import {
  ArgumentStore,
  CommandStore,
  InteractionHandlerStore,
  ListenerStore,
  PreconditionStore,
} from '@sapphire/framework';
import { EventEmitter } from 'node:events';

// Fake SapphireClient. Extends EventEmitter because Sapphire's
// ListenerLoaderStrategy.onLoad calls getMaxListeners()/on() when subscribing
// core listeners during store.loadAll(). We override emit() to capture events
// instead of dispatching — tests drive the listener flow explicitly via
// runCommand, and we read captured emits to determine outcome.
export class FakeSapphireClient extends EventEmitter {
  options: Record<string, unknown> = {};
  emits: Array<[string | symbol, ...unknown[]]> = [];

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    this.emits.push([event, ...args]);
    return true;
  }

  clearEmits(): void {
    this.emits.length = 0;
  }
}

export let fakeClient: FakeSapphireClient;

let bootstrapped = false;

async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  fakeClient = new FakeSapphireClient();
  (container as unknown as { client: FakeSapphireClient }).client = fakeClient;
  container.stores
    .register(new ArgumentStore())
    .register(new CommandStore())
    .register(new InteractionHandlerStore())
    .register(new ListenerStore())
    .register(new PreconditionStore());
  // Flush queued pieces into their stores: Sapphire's core listeners and
  // built-in preconditions self-queue via module side-effects on framework
  // import. After this, subsequent loadPiece calls insert immediately.
  await Promise.all([...container.stores.values()].map((s) => s.loadAll()));
}

export interface RegisterOptions {
  preconditions: Array<{ name: string; piece: new (...args: any[]) => any }>;
  command: { name: string; piece: new (...args: any[]) => any };
}

export async function registerForTest(opts: RegisterOptions): Promise<any> {
  await bootstrap();
  for (const p of opts.preconditions) {
    await container.stores.get('preconditions').loadPiece({ name: p.name, piece: p.piece });
  }
  await container.stores.get('commands').loadPiece({
    name: opts.command.name,
    piece: opts.command.piece,
  });
  return container.stores.get('commands').get(opts.command.name);
}

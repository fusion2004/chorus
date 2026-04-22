export function makeCommandLoaderContext() {
  return {
    root: '',
    path: '',
    name: 'test-command',
    store: {} as any,
  };
}

export function instantiateCommand(CommandClass: any): any {
  return new CommandClass(makeCommandLoaderContext() as any, {} as any);
}

export function getConfiguredPreconditions(command: any): string[] {
  return command.options?.preconditions ?? [];
}

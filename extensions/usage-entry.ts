import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import subtaskExtension from './index.ts';
import { createUsageFunnel } from './usage-funnel.ts';

const version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

export default function usageInstrumentedSubtask(pi: ExtensionAPI): void {
  if (process.env.PI_SUBTASK_CHILD === '1') {
    subtaskExtension(pi);
    return;
  }

  const funnel = createUsageFunnel('pi-subtask', version);
  pi.on('session_start', () => { void funnel.install(); });

  const instrumented = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === 'registerCommand') {
        return (name: string, command: any) => {
          if (name !== 'subtask' || typeof command?.handler !== 'function') return (target.registerCommand as any)(name, command);
          const handler = command.handler.bind(command);
          return (target.registerCommand as any)(name, {
            ...command,
            async handler(args: string, ...rest: any[]) {
              if (String(args ?? '').trim()) void funnel.activate();
              return handler(args, ...rest);
            },
          });
        };
      }
      if (property !== 'sendMessage') return Reflect.get(target, property, receiver);
      return (...args: any[]) => {
        const result = (target.sendMessage as any)(...args);
        const message = args[0];
        if (message?.customType === 'subtask' && message?.details?.exitCode === 0) void funnel.success();
        return result;
      };
    },
  }) as ExtensionAPI;

  subtaskExtension(instrumented);
}

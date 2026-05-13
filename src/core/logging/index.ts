export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export function consoleLogger(): Logger {
  return {
    info: (obj, msg) => console.log(msg ?? obj, typeof obj === 'object' ? obj : ''),
    warn: (obj, msg) => console.warn(msg ?? obj, typeof obj === 'object' ? obj : ''),
    error: (obj, msg) => console.error(msg ?? obj, typeof obj === 'object' ? obj : ''),
  };
}

export function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export function createLogger(_name: string): Logger {
  return consoleLogger();
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[mockrail] ${m}`),
  warn: (m) => console.warn(`[mockrail] ${m}`),
  error: (m, e) => console.error(`[mockrail] ${m}`, e ?? ''),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

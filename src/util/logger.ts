function timestamp(): string {
  return new Date().toISOString();
}

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (DEBUG) console.log(`[${timestamp()}] [DEBUG] ${message}`, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[${timestamp()}] ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[${timestamp()}] ${message}`, ...args);
  },
};

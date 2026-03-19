function timestamp(): string {
  return new Date().toISOString();
}

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const TRACE = process.env.TRACE === '1' || process.env.TRACE === 'true';

export const logger = {
  trace(message: string, ...args: unknown[]): void {
    if (TRACE) console.log(`[${timestamp()}] [TRACE] ${message}`, ...args);
  },
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

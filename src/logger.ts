import process from 'node:process';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const active = (): number => LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

/**
 * Every warn and error is kept here so a run can write `errors.log` next to its
 * CV. Recording is independent of LOG_LEVEL: a run that hides its warnings on
 * the console must still record them, or the log file lies by omission.
 *
 * Bounded, because a runaway retry loop must not eat the heap.
 */
const MAX_RECORDED = 500;
let recorded: string[] = [];

const emit = (level: Level, msg: string): void => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} [${level.toUpperCase()}] ${msg}`;
  if (LEVELS[level] >= LEVELS.warn && recorded.length < MAX_RECORDED) recorded.push(line);
  if (LEVELS[level] < active()) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export const logger = {
  debug: (msg: string) => emit('debug', msg),
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),

  /** Warn and error lines seen so far, oldest first. */
  problems: (): readonly string[] => recorded,
  resetProblems: (): void => {
    recorded = [];
  },
};

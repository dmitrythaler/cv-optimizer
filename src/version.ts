import { readFileSync } from 'node:fs';

/**
 * Package version, read from package.json rather than duplicated here.
 *
 * `../package.json` resolves to the project root from both `src/version.ts`
 * and the emitted `dist/version.js`, since both sit one level below it. npm
 * always ships package.json, so this holds for an installed package too.
 */
const read = (): string => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
};

export const version: string = read();

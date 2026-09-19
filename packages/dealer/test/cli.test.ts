import { describe, expect, it } from 'vitest';
import { CliError, DEFAULT_APP_URL, defaultDataDir, parseArgs } from '../src/index.js';

const env = { HOME: '/home/x' } as NodeJS.ProcessEnv;

describe('dealer CLI parsing', () => {
  it('parses a full host command', () => {
    const args = parseArgs(
      [
        'host',
        '--game',
        'ofc',
        '--rules',
        'rules.json',
        '--seats',
        '3',
        '--code',
        'abc123',
        '--entropy',
        'random.org',
        '--api-key',
        'k',
        '--fallback',
        '--data',
        '/tmp/d',
        '--app-url',
        'http://localhost:5173/',
        '--name',
        'Table 1',
      ],
      env,
    );
    expect(args).toEqual({
      cmd: 'host',
      game: 'ofc',
      rules: 'rules.json',
      seats: 3,
      code: 'ABC123',
      name: 'Table 1',
      entropy: 'random.org',
      apiKey: 'k',
      fallback: true,
      dealer: true,
      data: '/tmp/d',
      appUrl: 'http://localhost:5173/',
    });
  });

  it('applies defaults and environment', () => {
    const args = parseArgs(['host', '--game=backgammon'], {
      ...env,
      RANDOM_ORG_API_KEY: 'envkey',
      P2P_DEALER_DATA: '/data',
    });
    expect(args).toMatchObject({
      cmd: 'host',
      game: 'backgammon',
      apiKey: 'envkey',
      data: '/data',
      appUrl: DEFAULT_APP_URL,
      name: 'Dealer',
    });
    expect(defaultDataDir({} as NodeJS.ProcessEnv)).toMatch(/\.p2p-dealer$/);
    expect(parseArgs(['host', '--game', 'ofc', '--dealer=false'], env)).toMatchObject({
      dealer: false,
    });
  });

  it('parses resume, list, status, stop and help', () => {
    expect(parseArgs(['resume', 'ABC123'], env)).toMatchObject({ cmd: 'resume', target: 'ABC123' });
    expect(parseArgs(['list', '--data', '/d'], env)).toEqual({ cmd: 'list', data: '/d' });
    expect(parseArgs(['status', 'id-1'], env)).toMatchObject({ cmd: 'status', target: 'id-1' });
    expect(parseArgs(['stop', 'id-1'], env)).toMatchObject({ cmd: 'stop', target: 'id-1' });
    expect(parseArgs([], env)).toEqual({ cmd: 'help' });
    expect(parseArgs(['host', '--help'], env)).toEqual({ cmd: 'help' });
  });

  it('rejects bad input with clear messages', () => {
    const bad = (argv: string[]) => {
      try {
        parseArgs(argv, env);
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        return (e as Error).message;
      }
      throw new Error(`expected ${argv.join(' ')} to fail`);
    };
    expect(bad(['host'])).toMatch(/--game is required/);
    expect(bad(['host', '--game', 'chess'])).toMatch(/unknown game "chess"/);
    expect(bad(['host', '--game', 'ofc', '--seats', 'nine'])).toMatch(/--seats/);
    expect(bad(['host', '--game', 'ofc', '--code', 'a!'])).toMatch(/--code/);
    expect(bad(['host', '--game', 'ofc', '--entropy', 'dice'])).toMatch(/--entropy/);
    expect(bad(['host', '--game', 'ofc', '--bogus'])).toMatch(/unknown option --bogus/);
    expect(bad(['host', '--game'])).toMatch(/--game needs a value/);
    expect(bad(['resume'])).toMatch(/needs a table id or room code/);
    expect(bad(['dance'])).toMatch(/unknown command "dance"/);
  });
});

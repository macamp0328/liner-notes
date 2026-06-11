import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  classifyOutcome,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  resolveCircuitBreakerThreshold,
  resolveCircuitBreakerCooldownMs,
  type Outcome,
} from '../../../src/ingestion/circuit-breaker.js';
import { snapshotEnv } from '../../helpers/env.js';

type LogFn = Mock<(msg: string) => void>;

function makeLogger(): { warn: LogFn; info: LogFn; error: LogFn } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe('classifyOutcome', () => {
  const cases: Array<[string, Parameters<typeof classifyOutcome>[0], Outcome]> = [
    ['explicit transient beats everything', { transient: true, status: 403 }, 'transient'],
    ['html challenge is fatal despite 200', { htmlChallenge: true, status: 200 }, 'fatal'],
    ['401 is fatal', { status: 401 }, 'fatal'],
    ['403 is fatal', { status: 403 }, 'fatal'],
    ['451 is fatal', { status: 451 }, 'fatal'],
    ['404 is a miss', { status: 404 }, 'miss'],
    ['429 is transient', { status: 429 }, 'transient'],
    ['500 is transient', { status: 500 }, 'transient'],
    ['503 is transient', { status: 503 }, 'transient'],
    ['200 is success', { status: 200 }, 'success'],
    ['299 is success', { status: 299 }, 'success'],
    ['400 is a miss (per-request, never trips)', { status: 400 }, 'miss'],
    ['422 is a miss', { status: 422 }, 'miss'],
    ['ok without status is success', { ok: true }, 'success'],
    ['empty signal falls back to miss', {}, 'miss'],
  ];

  it.each(cases)('%s', (_label, signal, expected) => {
    expect(classifyOutcome(signal)).toBe(expected);
  });
});

describe('CircuitBreakerOpenError', () => {
  it('carries the source and a descriptive name/message', () => {
    const err = new CircuitBreakerOpenError('genius');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CircuitBreakerOpenError');
    expect(err.source).toBe('genius');
    expect(err.message).toContain('genius');
  });
});

describe('CircuitBreaker', () => {
  const fatal = (b: CircuitBreaker, n: number): void => {
    for (let i = 0; i < n; i++) b.record('fatal');
  };

  it('stays closed below the threshold and opens exactly on it', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 3, logger: makeLogger() });
    fatal(b, 2);
    expect(b.allowRequest()).toBe(true);
    expect(b.snapshot().state).toBe('closed');
    b.record('fatal'); // 3rd consecutive
    expect(b.allowRequest()).toBe(false);
    expect(b.snapshot().state).toBe('open');
  });

  it('logs the trip exactly once at warn, never per subsequent fatal', () => {
    const log = makeLogger();
    const b = new CircuitBreaker({ source: 'genius', threshold: 2, logger: log });
    fatal(b, 5); // opens at 2, three more fatals after
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain('genius');
  });

  it('allowRequest never logs', () => {
    const log = makeLogger();
    const b = new CircuitBreaker({ source: 'x', threshold: 1, logger: log });
    b.allowRequest();
    fatal(b, 1);
    b.allowRequest();
    b.allowRequest();
    expect(log.warn).toHaveBeenCalledTimes(1); // only the trip, not the allowRequest calls
  });

  it('success resets the consecutive counter', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 3, logger: makeLogger() });
    fatal(b, 2);
    b.record('success');
    fatal(b, 2);
    expect(b.snapshot().state).toBe('closed'); // never reached 3 in a row
  });

  it('a miss also resets (the source answered)', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 3, logger: makeLogger() });
    fatal(b, 2);
    b.record('miss');
    fatal(b, 2);
    expect(b.snapshot().state).toBe('closed');
  });

  it('transient neither trips nor rescues a blocked source', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 3, logger: makeLogger() });
    fatal(b, 2);
    b.record('transient'); // must NOT reset the consecutive counter
    b.record('fatal'); // 3rd consecutive across the transient
    expect(b.snapshot().state).toBe('open');
  });

  it('transient alone never opens', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 2, logger: makeLogger() });
    for (let i = 0; i < 10; i++) b.record('transient');
    expect(b.snapshot().state).toBe('closed');
    expect(b.allowRequest()).toBe(true);
  });

  it('snapshot tracks cumulative fatalCount across a reset', () => {
    const b = new CircuitBreaker({ source: 'x', threshold: 10, logger: makeLogger() });
    fatal(b, 2);
    b.record('success');
    fatal(b, 1);
    const snap = b.snapshot();
    expect(snap.fatalCount).toBe(3);
    expect(snap.consecutiveFatals).toBe(1);
    expect(snap.trippedAt).toBeNull();
  });

  describe('half-open (cooldownMs)', () => {
    it('without cooldown, stays open even as the clock advances', () => {
      let t = 1_000;
      const b = new CircuitBreaker({
        source: 'x',
        threshold: 1,
        logger: makeLogger(),
        now: () => t,
      });
      fatal(b, 1);
      t += 10_000_000;
      expect(b.allowRequest()).toBe(false);
    });

    it('after cooldown, permits one probe (half-open); a fatal probe re-opens and re-warns', () => {
      let t = 1_000;
      const log = makeLogger();
      const b = new CircuitBreaker({
        source: 'x',
        threshold: 1,
        cooldownMs: 5_000,
        logger: log,
        now: () => t,
      });
      fatal(b, 1); // opens, trippedAt=1000, warn #1
      expect(b.allowRequest()).toBe(false); // cooldown not elapsed
      t += 5_000;
      expect(b.allowRequest()).toBe(true); // half-open probe
      expect(b.snapshot().state).toBe('half-open');
      b.record('fatal'); // probe fails → re-open, warn #2
      expect(b.snapshot().state).toBe('open');
      expect(log.warn).toHaveBeenCalledTimes(2);
    });

    it('a successful probe closes the breaker', () => {
      let t = 1_000;
      const b = new CircuitBreaker({
        source: 'x',
        threshold: 1,
        cooldownMs: 5_000,
        logger: makeLogger(),
        now: () => t,
      });
      fatal(b, 1);
      t += 5_000;
      b.allowRequest(); // → half-open
      b.record('success');
      expect(b.snapshot().state).toBe('closed');
      expect(b.allowRequest()).toBe(true);
    });

    it('admits only ONE probe while half-open (concurrent callers get false)', () => {
      let t = 1_000;
      const b = new CircuitBreaker({
        source: 'x',
        threshold: 1,
        cooldownMs: 5_000,
        logger: makeLogger(),
        now: () => t,
      });
      fatal(b, 1);
      t += 5_000;
      expect(b.allowRequest()).toBe(true); // the single probe
      expect(b.allowRequest()).toBe(false); // a concurrent caller is blocked until record() settles
      expect(b.allowRequest()).toBe(false);
    });

    it('a transient probe re-arms the cooldown (no deadlock, retries after another cooldown)', () => {
      let t = 1_000;
      const b = new CircuitBreaker({
        source: 'x',
        threshold: 1,
        cooldownMs: 5_000,
        logger: makeLogger(),
        now: () => t,
      });
      fatal(b, 1);
      t += 5_000;
      b.allowRequest(); // → half-open
      b.record('transient'); // inconclusive → back to open, cooldown re-armed
      expect(b.snapshot().state).toBe('open');
      expect(b.allowRequest()).toBe(false); // cooldown restarted from now
      t += 5_000;
      expect(b.allowRequest()).toBe(true); // a later probe is allowed again
    });
  });
});

describe('env resolvers', () => {
  const env = snapshotEnv(['CIRCUIT_BREAKER_THRESHOLD', 'CIRCUIT_BREAKER_COOLDOWN_MS']);
  afterEach(() => env.restore());

  it('threshold: honors a valid value', () => {
    env.clear();
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '8';
    expect(resolveCircuitBreakerThreshold()).toBe(8);
  });

  it('threshold: defaults when unset or malformed', () => {
    env.clear();
    expect(resolveCircuitBreakerThreshold()).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5x';
    expect(resolveCircuitBreakerThreshold()).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  });

  it('threshold: clamps below 1', () => {
    env.clear();
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '0';
    expect(resolveCircuitBreakerThreshold()).toBe(1);
  });

  it('cooldown: positive value honored, else undefined', () => {
    env.clear();
    expect(resolveCircuitBreakerCooldownMs()).toBeUndefined();
    process.env['CIRCUIT_BREAKER_COOLDOWN_MS'] = '0';
    expect(resolveCircuitBreakerCooldownMs()).toBeUndefined();
    process.env['CIRCUIT_BREAKER_COOLDOWN_MS'] = 'abc';
    expect(resolveCircuitBreakerCooldownMs()).toBeUndefined();
    process.env['CIRCUIT_BREAKER_COOLDOWN_MS'] = '30000';
    expect(resolveCircuitBreakerCooldownMs()).toBe(30_000);
  });
});

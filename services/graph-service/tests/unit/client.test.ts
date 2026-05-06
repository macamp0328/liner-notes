import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockVerifyConnectivity = vi.fn().mockResolvedValue(undefined);
const mockDriver = { close: mockClose, verifyConnectivity: mockVerifyConnectivity };

vi.mock('neo4j-driver', () => ({
  default: {
    driver: vi.fn().mockReturnValue(mockDriver),
    auth: { basic: vi.fn().mockReturnValue({}) },
  },
}));

describe('Neo4j client', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('getDriver throws before initDriver is called', async () => {
    const { getDriver } = await import('../../src/db/client.js');
    expect(() => getDriver()).toThrow('Neo4j driver not initialized');
  });

  it('initDriver returns a driver and getDriver returns it', async () => {
    const { initDriver, getDriver } = await import('../../src/db/client.js');
    const driver = initDriver('bolt://localhost', 'neo4j', 'test');
    expect(driver).toBe(mockDriver);
    expect(getDriver()).toBe(mockDriver);
  });

  it('closeDriver closes the driver and resets state', async () => {
    const { initDriver, closeDriver, getDriver } = await import('../../src/db/client.js');
    initDriver('bolt://localhost', 'neo4j', 'test');
    await closeDriver();
    expect(mockClose).toHaveBeenCalled();
    expect(() => getDriver()).toThrow('Neo4j driver not initialized');
  });

  it('closeDriver is safe to call when no driver is initialized', async () => {
    const { closeDriver } = await import('../../src/db/client.js');
    await expect(closeDriver()).resolves.toBeUndefined();
  });
});

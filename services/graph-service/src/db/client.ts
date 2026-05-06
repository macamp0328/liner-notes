import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

export function initDriver(uri: string, user: string, password: string): Driver {
  if (driver) return driver; // already initialized — avoid leaking connections
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  return driver;
}

export function getDriver(): Driver {
  if (!driver) {
    throw new Error('Neo4j driver not initialized — call initDriver() first');
  }
  return driver;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

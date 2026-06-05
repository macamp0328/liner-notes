import autocannon from 'autocannon';
import { buildServer } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';
import { initTestDriver } from '../integration/setup.js';
import { clearGraph, seedGraph, seedExploreEnrichment } from '../fixtures/loader.js';
import { getDriver } from '../../src/db/client.js';

async function runLoadTest() {
  let app: FastifyInstance | undefined;
  try {
    console.log('Seeding test database...');
    // We only need the test driver if we're hitting the test db,
    // but users might run this against the dev db, so let's allow overriding.
    // Use test setup only if NEO4J_TEST_URI is present, otherwise assume it's running
    // with dev settings (NEO4J_URI) or whatever is in process.env
    let app: FastifyInstance | undefined;
    if (process.env.NEO4J_TEST_URI) {
      initTestDriver();
      await clearGraph(getDriver());
      await seedGraph(getDriver());
      await seedExploreEnrichment(getDriver());
    } else {
      console.log(
        'NEO4J_TEST_URI not set, skipping DB clear/seed, assuming DB is already populated...',
      );
    }

    console.log('Starting server...');
    app = await buildServer({
      rateLimitMax: Number.MAX_SAFE_INTEGER, // Disable rate limiting for load tests
      logger: false, // Disable logging for load tests to get clean output and not impact performance
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'string' ? 0 : address?.port;

    if (!port) {
      throw new Error('Could not get port');
    }

    const url = `http://127.0.0.1:${port}`;
    console.log(`Server started on ${url}`);

    const runAutocannon = (options: autocannon.Options): Promise<autocannon.Result> => {
      return new Promise((resolve, reject) => {
        autocannon(options, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
    };

    console.log('\nRunning load test for /api/v1/health...');
    const result1 = await runAutocannon({
      url,
      connections: 20,
      pipelining: 1,
      duration: 5,
      requests: [{ method: 'GET', path: '/api/v1/health' }],
    });
    console.log(autocannon.printResult(result1));

    console.log('\nRunning load test for /api/v1/stats...');
    const result2 = await runAutocannon({
      url,
      connections: 20,
      pipelining: 1,
      duration: 10,
      requests: [{ method: 'GET', path: '/api/v1/stats' }],
    });
    console.log(autocannon.printResult(result2));

    console.log('\nRunning load test for /api/v1/explore/releases/most-pressed...');
    const result3 = await runAutocannon({
      url,
      connections: 20,
      pipelining: 1,
      duration: 10,
      requests: [{ method: 'GET', path: '/api/v1/explore/releases/most-pressed' }],
    });
    console.log(autocannon.printResult(result3));

    console.log('\nRunning load test for /api/v1/search...');
    const result4 = await runAutocannon({
      url,
      connections: 20,
      pipelining: 1,
      duration: 10,
      requests: [
        { method: 'GET', path: '/api/v1/search?q=test' },
        { method: 'GET', path: '/api/v1/search?q=love' },
        { method: 'GET', path: '/api/v1/search?q=time' },
      ],
    });
    console.log(autocannon.printResult(result4));

    console.log('\nRunning load test for /api/v1/search/lyrics...');
    const result5 = await runAutocannon({
      url,
      connections: 20,
      pipelining: 1,
      duration: 10,
      requests: [
        { method: 'GET', path: '/api/v1/search/lyrics?q=love' },
        { method: 'GET', path: '/api/v1/search/lyrics?q=heart' },
        { method: 'GET', path: '/api/v1/search/lyrics?q=time' },
      ],
    });
    console.log(autocannon.printResult(result5));
  } catch (err) {
    console.error('Error running load test:', err);
  } finally {
    if (app) {
      await app.close();
    }
    process.exit(0);
  }
}

runLoadTest();

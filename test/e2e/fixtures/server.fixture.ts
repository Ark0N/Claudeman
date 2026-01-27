/**
 * Server fixture for E2E tests
 * Manages WebServer lifecycle with proper startup/shutdown
 */

import { WebServer } from '../../../src/web/server.js';

export interface ServerFixture {
  server: WebServer;
  port: number;
  baseUrl: string;
}

/**
 * Create and start a server fixture
 * @param port - Port to run the server on
 * @returns ServerFixture with server instance and connection info
 */
export async function createServerFixture(port: number): Promise<ServerFixture> {
  const server = new WebServer(port);
  await server.start();

  // Wait for server to be fully ready
  const maxWait = 10000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(`http://localhost:${port}/api/status`);
      if (response.ok) {
        break;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }

  return {
    server,
    port,
    baseUrl: `http://localhost:${port}`,
  };
}

/**
 * Stop and cleanup a server fixture
 * @param fixture - Server fixture to destroy
 */
export async function destroyServerFixture(fixture: ServerFixture): Promise<void> {
  if (fixture.server) {
    await fixture.server.stop();
  }
}

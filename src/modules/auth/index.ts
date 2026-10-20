import { loadEnvFile } from '../../utils/env.js';

export * from './contracts.js';
export * from './auth.js';

/**
 * Self-test routine for the Auth Module.
 * Verifies cookie detection logic and credentials configuration.
 */
export async function testAuthModule(): Promise<{
  success: boolean;
  hasCredentials: boolean;
  errors: string[];
}> {
  loadEnvFile();
  const errors: string[] = [];
  const username = process.env.X_USERNAME?.trim();
  const password = process.env.X_PWD?.trim();

  const hasCredentials = Boolean(username && password);
  if (!hasCredentials) {
    errors.push('X_USERNAME or X_PWD not configured in environment (simulated check)');
  }

  // Verify cookie detection function with mock
  const { isXLoggedIn } = await import('./auth.js');
  const mockContextWithAuth = {
    cookies: async () => [{ name: 'auth_token', value: 'mock_test_token_12345' }],
    addCookies: async () => {},
  } as any;
  const loggedIn = await isXLoggedIn(mockContextWithAuth);
  if (!loggedIn) {
    errors.push('isXLoggedIn failed to detect mock auth_token');
  }

  return {
    success: errors.length === 0,
    hasCredentials,
    errors,
  };
}

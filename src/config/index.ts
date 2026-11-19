export interface AppConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  siteKey: string;
  debug: boolean;
  dev: boolean;
}
type Environment = Record<string, string | boolean | undefined>;

export const EXAMPLE_PLACEHOLDERS = {
  VITE_FIREBASE_API_KEY: 'YOUR_FIREBASE_API_KEY',
  VITE_FIREBASE_AUTH_DOMAIN: 'YOUR_FIREBASE_AUTH_DOMAIN',
  VITE_FIREBASE_PROJECT_ID: 'YOUR_FIREBASE_PROJECT_ID',
  VITE_FIREBASE_APP_ID: 'YOUR_FIREBASE_APP_ID',
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY',
} as const;

export function readConfig(env: Environment): AppConfig | null {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim() !== '' &&
    !Object.values(EXAMPLE_PLACEHOLDERS).some((placeholder) => placeholder === value.trim());
  const fields = [
    env.VITE_FIREBASE_API_KEY,
    env.VITE_FIREBASE_AUTH_DOMAIN,
    env.VITE_FIREBASE_PROJECT_ID,
    env.VITE_FIREBASE_APP_ID,
  ];
  const debug = import.meta.env.DEV && env.DEV === true && env.VITE_APPCHECK_DEBUG === 'true';
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (!fields.every(valid) || (!debug && !valid(siteKey))) return null;
  const [apiKey, authDomain, projectId, appId] = fields as string[];
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    siteKey: valid(siteKey) ? siteKey : '',
    dev: env.DEV === true,
    debug,
  };
}

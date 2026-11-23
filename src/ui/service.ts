import { useEffect, useState } from 'react';
import { readConfig } from '../config';
import { browserApi, makeFirebaseModel } from '../ai/firebase';
import { languageOptions, LocalModelService } from '../ai/localModel';
import { startAutoPrepare } from './autoPrepare';

export const config = readConfig({
  DEV: import.meta.env.DEV,
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY,
  ...(import.meta.env.DEV ? { VITE_APPCHECK_DEBUG: import.meta.env.VITE_APPCHECK_DEBUG } : {}),
});
let pageService: LocalModelService | undefined;
export function createService() {
  if (pageService) return pageService;
  pageService = new LocalModelService({
    configured: config !== null,
    hasApi: () => typeof browserApi()?.availability === 'function',
    availability: () => browserApi()!.availability(languageOptions),
    createModel: () => {
      if (!config) throw new Error('Firebase is not configured.');
      return makeFirebaseModel(config);
    },
    isForeground: () => document.visibilityState === 'visible',
    onForeground: callback => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    now: () => performance.now(),
  });
  return pageService;
}
export function startReadiness(service: LocalModelService): () => void {
  return startAutoPrepare(service, config !== null, {
    hasApi: () => typeof browserApi()?.availability === 'function',
    foreground: () => document.visibilityState === 'visible',
    onVisibility: callback => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  });
}
export function useForeground() {
  const [isForeground, setForeground] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setForeground(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return isForeground;
}

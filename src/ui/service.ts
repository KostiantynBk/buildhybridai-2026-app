import { useEffect, useState } from 'react';
import { readConfig } from '../config';
import { browserApi, makeFirebaseModel } from '../ai/firebase';
import { languageOptions, LocalModelService } from '../ai/localModel';
import { startAutoPrepare } from './autoPrepare';

export const config = readConfig(import.meta.env);
export function createService() {
  return new LocalModelService({
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

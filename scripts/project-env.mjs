import { loadEnv } from 'vite';

export function deploymentProject(directory) {
  const project = loadEnv('production', directory, 'VITE_').VITE_FIREBASE_PROJECT_ID ?? '';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error('Set a valid VITE_FIREBASE_PROJECT_ID in the production environment.');
  }
  return project;
}

import { spawnSync } from 'node:child_process';
import { deploymentProject } from './project-env.mjs';

const firebaseTools = 'firebase-tools@15.37.0';
let project;
try { project = deploymentProject(process.cwd()); } catch {
  console.error('Missing or invalid production VITE_FIREBASE_PROJECT_ID.');
  process.exit(1);
}
const args = ['--yes', firebaseTools, 'deploy', '--only', 'hosting', '--project', project];
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error('Could not launch Firebase CLI.');
process.exit(result.status ?? 1);

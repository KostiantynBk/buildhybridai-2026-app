export function developerRoute(path: string, dev: boolean): 'eval' | 'dev' | 'app' {
  if (dev && path === '/eval') return 'eval';
  if (dev && path === '/dev') return 'dev';
  return 'app';
}

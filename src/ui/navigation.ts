export function navigationItems(dev: boolean): string[] {
  return ['Notebook', 'Profile', 'Outbox', ...(dev ? ['Insights'] : [])];
}

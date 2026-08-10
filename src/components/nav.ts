import type { IconName } from './ui';

export type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconName;
};

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', shortLabel: 'Home', icon: 'home' },
  { href: '/library', label: 'Library', shortLabel: 'Library', icon: 'folder' },
  { href: '/calendar', label: 'Calendar', shortLabel: 'Calendar', icon: 'calendar' },
  { href: '/study', label: 'Study Center', shortLabel: 'Study', icon: 'zap' },
  { href: '/todos', label: 'To-dos', shortLabel: 'To-dos', icon: 'check-square' },
];

/** `/` only matches exactly; everything else matches its subtree. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

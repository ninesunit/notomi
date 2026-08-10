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
  { href: '/timetable', label: 'Timetable', shortLabel: 'Classes', icon: 'grid' },
  { href: '/study', label: 'Study Center', shortLabel: 'Study', icon: 'zap' },
  { href: '/focus', label: 'Focus', shortLabel: 'Focus', icon: 'target' },
  { href: '/todos', label: 'To-dos', shortLabel: 'To-dos', icon: 'check-square' },
  { href: '/capture', label: 'Capture', shortLabel: 'Capture', icon: 'camera' },
  { href: '/calendar', label: 'Calendar', shortLabel: 'Calendar', icon: 'calendar' },
  { href: '/program', label: 'Program', shortLabel: 'Program', icon: 'layers' },
];

/**
 * The bottom bar holds fewer items than the rail — six 60px tabs already fill a
 * phone. Calendar, Program and Capture are cut: the first two are reached from
 * the dashboard, and Capture is a home-screen shortcut, which is the whole
 * point of it.
 */
export const TAB_ITEMS: NavItem[] = NAV_ITEMS.filter(
  (item) => !['/calendar', '/program', '/capture'].includes(item.href)
);

/** `/` only matches exactly; everything else matches its subtree. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

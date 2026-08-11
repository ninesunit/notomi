import type { IconName } from './ui';

export type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconName;
};

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', shortLabel: 'Home', icon: 'home' },
  { href: '/timetable', label: 'Timetable', shortLabel: 'Classes', icon: 'grid' },
  { href: '/library', label: 'Library', shortLabel: 'Library', icon: 'folder' },
  { href: '/program', label: 'Program structure', shortLabel: 'Program', icon: 'layers' },
  { href: '/todos', label: 'Tasks', shortLabel: 'Tasks', icon: 'check-square' },
  { href: '/calendar', label: 'Calendar', shortLabel: 'Calendar', icon: 'calendar' },
  { href: '/study', label: 'Study Center', shortLabel: 'Study', icon: 'zap' },
  { href: '/focus', label: 'Focus', shortLabel: 'Focus', icon: 'target' },
  { href: '/capture', label: 'Capture', shortLabel: 'Capture', icon: 'camera' },
  { href: '/friends', label: 'Friends', shortLabel: 'Friends', icon: 'users' },
  { href: '/settings', label: 'Settings', shortLabel: 'Settings', icon: 'settings' },
];

/**
 * The drawer groups rather than lists.
 *
 * Nine flat rows read as a wall; split into what a student is doing right now
 * versus what they study with, each group is scannable in one glance. Settings
 * is deliberately absent — it lives beside the profile at the foot of the
 * drawer, which is where people look for it.
 */
export const DRAWER_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Study',
    items: NAV_ITEMS.filter((item) =>
      ['/', '/timetable', '/library', '/program', '/todos', '/calendar'].includes(item.href)
    ),
  },
  {
    title: 'Tools',
    items: NAV_ITEMS.filter((item) =>
      ['/study', '/focus', '/capture', '/friends'].includes(item.href)
    ),
  },
];

/** `/` only matches exactly; everything else matches its subtree. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

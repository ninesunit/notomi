import type { IconName } from './Icon';

export type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconName;
  legacyPaths?: string[];
};

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    shortLabel: 'Dashboard',
    icon: 'layout-dashboard',
    legacyPaths: ['/', '/today'],
  },
  {
    href: '/knowledge',
    label: 'Knowledge',
    shortLabel: 'Knowledge',
    icon: 'book-open',
    legacyPaths: ['/library', '/reader', '/study'],
  },
  {
    href: '/schedule',
    label: 'Schedule & Calendar',
    shortLabel: 'Schedule',
    icon: 'calendar',
    legacyPaths: ['/academics', '/timetable', '/calendar', '/program'],
  },
  {
    href: '/tasks',
    label: 'Tasks & Focus',
    shortLabel: 'Tasks',
    icon: 'check-square',
    legacyPaths: ['/studio', '/todos', '/focus', '/capture'],
  },
  {
    href: '/reel',
    label: 'Notomi Reel',
    shortLabel: 'Reel',
    icon: 'film',
  },
  {
    href: '/social',
    label: 'Arena & Social',
    shortLabel: 'Social',
    icon: 'users',
    legacyPaths: ['/friends'],
  },
];

export const SETTINGS_ITEM: NavItem = {
  href: '/settings',
  label: 'Settings',
  shortLabel: 'Settings',
  icon: 'settings',
};

export const DRAWER_SECTIONS = [{ title: 'Workspace', items: NAV_ITEMS }];

export function isActive(pathname: string, href: string, legacyPaths: string[] = []): boolean {
  const matches = (path: string) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  return matches(href) || legacyPaths.some(matches);
}

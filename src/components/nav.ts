import type { IconName } from './Icon';

export type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconName;
  legacyPaths?: string[];
};

/**
 * Five surfaces, and Settings pinned below them.
 *
 * Notomi Reel was a sixth. It duplicated flashcards, the reader and spaced
 * repetition while adding an infinite feed to a product whose whole claim is
 * that studying should feel purposeful. Its cards live on, in Knowledge, in
 * sessions a student starts deliberately.
 */
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
    legacyPaths: ['/library', '/reader', '/study', '/reel'],
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

/**
 * Is this a screen the student navigated *into*, rather than one of the places
 * the nav can reach directly?
 *
 * Used to decide what a left-edge swipe means. The nav destinations are the
 * roots — there is nothing above them, so the edge keeps opening the drawer.
 * Everything else is a subject, a document, a notebook or a profile, reached by
 * tapping through, and on those the edge means back.
 *
 * Derived from NAV_ITEMS rather than listed separately so a new nav
 * destination cannot quietly start behaving like a detail screen.
 */
export function isDetailRoute(pathname: string): boolean {
  const roots = [...NAV_ITEMS.map((item) => item.href), SETTINGS_ITEM.href, '/', '/index'];
  const path = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  return !roots.some((root) => path === root || path === `${root}/`);
}

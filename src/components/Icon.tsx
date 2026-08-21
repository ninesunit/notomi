import type { ComponentType } from 'react';
import type { SvgProps } from 'react-native-svg';

import { useTheme, type Theme } from '@/lib/theme';

/*
 * One import per icon, rather than 116 names off the package barrel.
 *
 * Metro does not tree-shake a re-export barrel, so naming them that way pulled
 * the whole set into the bundle — every one of the 1,700-odd icons lucide
 * ships, including the croissant. Deep paths are the package's own supported
 * entry points and cost nothing but this comment and some vertical space.
 */
import Activity from 'lucide-react-native/icons/activity';
import AlertCircle from 'lucide-react-native/icons/circle-alert';
import AlertTriangle from 'lucide-react-native/icons/triangle-alert';
import ArrowDownToLine from 'lucide-react-native/icons/arrow-down-to-line';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import ArrowUpRight from 'lucide-react-native/icons/arrow-up-right';
import Award from 'lucide-react-native/icons/award';
import Bell from 'lucide-react-native/icons/bell';
import Book from 'lucide-react-native/icons/book';
import BookOpen from 'lucide-react-native/icons/book-open';
import Bookmark from 'lucide-react-native/icons/bookmark';
import Brush from 'lucide-react-native/icons/brush';
import Calendar from 'lucide-react-native/icons/calendar';
import CalendarDays from 'lucide-react-native/icons/calendar-days';
import Camera from 'lucide-react-native/icons/camera';
import Check from 'lucide-react-native/icons/check';
import CheckCircle from 'lucide-react-native/icons/circle-check-big';
import CheckCircle2 from 'lucide-react-native/icons/circle-check';
import CheckSquare from 'lucide-react-native/icons/square-check-big';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import Circle from 'lucide-react-native/icons/circle';
import Clipboard from 'lucide-react-native/icons/clipboard';
import Clock from 'lucide-react-native/icons/clock';
import CornerDownLeft from 'lucide-react-native/icons/corner-down-left';
import CornerDownRight from 'lucide-react-native/icons/corner-down-right';
import Crop from 'lucide-react-native/icons/crop';
import Crosshair from 'lucide-react-native/icons/crosshair';
import Download from 'lucide-react-native/icons/download';
import Edit from 'lucide-react-native/icons/square-pen';
import Eraser from 'lucide-react-native/icons/eraser';
import ExternalLink from 'lucide-react-native/icons/external-link';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import Lock from 'lucide-react-native/icons/lock';
import ListFilter from 'lucide-react-native/icons/list-filter';
import Coffee from 'lucide-react-native/icons/coffee';
import Atom from 'lucide-react-native/icons/atom';
import FlaskConical from 'lucide-react-native/icons/flask-conical';
import Leaf from 'lucide-react-native/icons/leaf';
import Rocket from 'lucide-react-native/icons/rocket';
import MoonStar from 'lucide-react-native/icons/moon-star';
import Cat from 'lucide-react-native/icons/cat';
import Palette from 'lucide-react-native/icons/palette';
import Feather from 'lucide-react-native/icons/feather';
import File from 'lucide-react-native/icons/file';
import FileDown from 'lucide-react-native/icons/file-down';
import FilePlus from 'lucide-react-native/icons/file-plus';
import FileText from 'lucide-react-native/icons/file-text';
import Film from 'lucide-react-native/icons/film';
import Flag from 'lucide-react-native/icons/flag';
import Flame from 'lucide-react-native/icons/flame';
import Folder from 'lucide-react-native/icons/folder';
import FolderKanban from 'lucide-react-native/icons/folder-kanban';
import FolderPlus from 'lucide-react-native/icons/folder-plus';
import GraduationCap from 'lucide-react-native/icons/graduation-cap';
import Headphones from 'lucide-react-native/icons/headphones';
import HelpCircle from 'lucide-react-native/icons/circle-question-mark';
import Highlighter from 'lucide-react-native/icons/highlighter';
import Image from 'lucide-react-native/icons/image';
import Lasso from 'lucide-react-native/icons/lasso';
import Layers from 'lucide-react-native/icons/layers';
import LayoutDashboard from 'lucide-react-native/icons/layout-dashboard';
import Link from 'lucide-react-native/icons/link';
import List from 'lucide-react-native/icons/list';
import Loader from 'lucide-react-native/icons/loader';
import LogOut from 'lucide-react-native/icons/log-out';
import Map from 'lucide-react-native/icons/map';
import Menu from 'lucide-react-native/icons/menu';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Mic from 'lucide-react-native/icons/mic';
import Minus from 'lucide-react-native/icons/minus';
import Monitor from 'lucide-react-native/icons/monitor';
import Moon from 'lucide-react-native/icons/moon';
import MoreHorizontal from 'lucide-react-native/icons/ellipsis';
import MousePointer2 from 'lucide-react-native/icons/mouse-pointer-2';
import Network from 'lucide-react-native/icons/network';
import NotebookPen from 'lucide-react-native/icons/notebook-pen';
import Package from 'lucide-react-native/icons/package';
import PanelLeftClose from 'lucide-react-native/icons/panel-left-close';
import PanelLeftOpen from 'lucide-react-native/icons/panel-left-open';
import Paperclip from 'lucide-react-native/icons/paperclip';
import Pause from 'lucide-react-native/icons/pause';
import PenTool from 'lucide-react-native/icons/pen-tool';
import Pencil from 'lucide-react-native/icons/pencil';
import Play from 'lucide-react-native/icons/play';
import Plus from 'lucide-react-native/icons/plus';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Repeat2 from 'lucide-react-native/icons/repeat-2';
import RotateCcw from 'lucide-react-native/icons/rotate-ccw';
import Search from 'lucide-react-native/icons/search';
import Send from 'lucide-react-native/icons/send';
import Settings from 'lucide-react-native/icons/settings';
import Share2 from 'lucide-react-native/icons/share-2';
import Shield from 'lucide-react-native/icons/shield';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import Sparkles from 'lucide-react-native/icons/sparkles';
import Square from 'lucide-react-native/icons/square';
import SquarePen from 'lucide-react-native/icons/square-pen';
import Star from 'lucide-react-native/icons/star';
import Sun from 'lucide-react-native/icons/sun';
import Swords from 'lucide-react-native/icons/swords';
import Target from 'lucide-react-native/icons/target';
import Timer from 'lucide-react-native/icons/timer';
import Trash2 from 'lucide-react-native/icons/trash-2';
import TrendingUp from 'lucide-react-native/icons/trending-up';
import Trophy from 'lucide-react-native/icons/trophy';
import Upload from 'lucide-react-native/icons/upload';
import UploadCloud from 'lucide-react-native/icons/cloud-upload';
import User from 'lucide-react-native/icons/user';
import UserCheck from 'lucide-react-native/icons/user-check';
import UserMinus from 'lucide-react-native/icons/user-minus';
import UserPlus from 'lucide-react-native/icons/user-plus';
import Users from 'lucide-react-native/icons/users';
import UsersRound from 'lucide-react-native/icons/users-round';
import Video from 'lucide-react-native/icons/video';
import Volume2 from 'lucide-react-native/icons/volume-2';
import VolumeX from 'lucide-react-native/icons/volume-x';
import X from 'lucide-react-native/icons/x';
import XCircle from 'lucide-react-native/icons/circle-x';
import Zap from 'lucide-react-native/icons/zap';
import ZoomIn from 'lucide-react-native/icons/zoom-in';

const ICONS = {
  activity: Activity,
  'alert-circle': AlertCircle,
  'alert-triangle': AlertTriangle,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-up-right': ArrowUpRight,
  award: Award,
  bell: Bell,
  book: Book,
  'book-open': BookOpen,
  bookmark: Bookmark,
  brush: Brush,
  calendar: Calendar,
  'calendar-days': CalendarDays,
  camera: Camera,
  check: Check,
  'check-circle': CheckCircle,
  'check-circle-2': CheckCircle2,
  'check-square': CheckSquare,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  circle: Circle,
  clipboard: Clipboard,
  clock: Clock,
  'corner-down-left': CornerDownLeft,
  'corner-down-right': CornerDownRight,
  crop: Crop,
  crosshair: Crosshair,
  download: Download,
  edit: Edit,
  'edit-2': Edit,
  'edit-3': SquarePen,
  eraser: Eraser,
  'external-link': ExternalLink,
  eye: Eye,
  'eye-off': EyeOff,
  lock: Lock,
  filter: ListFilter,
  'coffee': Coffee,
  'atom': Atom,
  'flask-conical': FlaskConical,
  'leaf': Leaf,
  'rocket': Rocket,
  'moon-star': MoonStar,
  'cat': Cat,
  'palette': Palette,
  feather: Feather,
  file: File,
  'file-down': FileDown,
  'file-plus': FilePlus,
  'file-text': FileText,
  flame: Flame,
  flag: Flag,
  folder: Folder,
  'folder-plus': FolderPlus,
  'folder-kanban': FolderKanban,
  'git-merge': Network,
  'graduation-cap': GraduationCap,
  headphones: Headphones,
  'help-circle': HelpCircle,
  highlighter: Highlighter,
  image: Image,
  layers: Layers,
  lasso: Lasso,
  'layout-dashboard': LayoutDashboard,
  'link-2': Link,
  list: List,
  loader: Loader,
  'log-out': LogOut,
  map: Map,
  menu: Menu,
  'message-circle': MessageCircle,
  mic: Mic,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  'more-horizontal': MoreHorizontal,
  'mouse-pointer-2': MousePointer2,
  network: Network,
  'notebook-pen': NotebookPen,
  package: Package,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  paperclip: Paperclip,
  pause: Pause,
  'pen-tool': PenTool,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  'refresh-cw': RefreshCw,
  repeat: Repeat2,
  'rotate-ccw': RotateCcw,
  search: Search,
  send: Send,
  settings: Settings,
  'share-2': Share2,
  shield: Shield,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  sun: Sun,
  square: Square,
  'square-pen': SquarePen,
  star: Star,
  swords: Swords,
  target: Target,
  timer: Timer,
  'trash-2': Trash2,
  'trending-up': TrendingUp,
  trophy: Trophy,
  upload: Upload,
  'upload-cloud': UploadCloud,
  user: User,
  'user-check': UserCheck,
  'user-minus': UserMinus,
  'user-plus': UserPlus,
  users: Users,
  'users-round': UsersRound,
  film: Film,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  x: X,
  'x-circle': XCircle,
  zap: Zap,
  'zoom-in': ZoomIn,
} satisfies Record<string, ComponentType<SvgProps>>;

export type IconName = keyof typeof ICONS;

type Tone =
  /** Body text and most glyphs. */
  | 'muted'
  /** Secondary, de-emphasised. */
  | 'subtle'
  /** Primary text weight. */
  | 'ink'
  /** On a dark or accent-filled surface. */
  | 'inverse'
  | 'accent'
  | 'pine'
  | 'amber'
  | 'rose'
  /** Dividers and other structural marks. */
  | 'line';

/**
 * What an icon is *for*, rather than what colour it happens to be today.
 *
 * Every one of the 236 icons in the app passes an explicit colour, and 213 of
 * those pass a hex literal — because this component takes a plain string, so
 * Tailwind classes cannot reach inside it. That was fine while there was one
 * palette. It stops being fine the moment there are two, since a hex baked into
 * a call site cannot know which one is active.
 *
 * The mapping turned out to be mechanical rather than a matter of taste: those
 * 213 sites use only eleven distinct values, and each maps onto exactly one
 * meaning. So this is a rename with a purpose, not a redesign.
 */
const LIGHT: Record<Tone, string> = {
  muted: '#6F6A5F',
  subtle: '#9A9488',
  ink: '#18181B',
  inverse: '#F7F5EE',
  accent: '#B4552D',
  pine: '#2E6F5E',
  amber: '#B4832A',
  rose: '#B0443E',
  line: '#C9C4B8',
};

/**
 * The same nine meanings on the dark ground, not the same nine colours.
 *
 * `inverse` is the one worth reading twice: it means "on a filled surface",
 * and the filled surface is `bg-ink`, which in the dark is cream. So inverse
 * flips with it. Everything else is lifted until it clears the ground —
 * `accent` at #B4552D measures 3.79:1 on near-black, which is legible and
 * lifeless, so it rises with the rest of the palette.
 */
const DARK: Record<Tone, string> = {
  muted: '#A9A296',
  subtle: '#7C766A',
  ink: '#F2EFE7',
  inverse: '#14130F',
  accent: '#E08A5E',
  pine: '#5FAF95',
  amber: '#D9AC5C',
  rose: '#E0776F',
  line: '#3F3A33',
};

const TONES: Record<Theme, Record<Tone, string>> = { light: LIGHT, dark: DARK };

export type IconTone = Tone;

/**
 * The same tones, for the handful of call sites that cannot use the prop: an
 * ActivityIndicator, or an icon whose colour is a subject's on one branch and
 * the theme's on the other. Reading them through a hook rather than an export
 * is what will let the dark palette arrive without touching those sites again.
 */
export function useTones(): Record<IconTone, string> {
  return TONES[useTheme()];
}

export function Icon({
  name,
  size = 16,
  color,
  tone,
  strokeWidth = 1.75,
  ...props
}: SvgProps & {
  name: IconName;
  size?: number;
  /**
   * An explicit colour, for the cases a tone cannot express: subject colours,
   * notebook colours, anything chosen by the student rather than by the theme.
   * Wins over `tone` when both are given.
   */
  color?: string;
  /** Preferred over `color` for anything the theme owns. */
  tone?: IconTone;
  strokeWidth?: number;
}) {
  const tones = useTones();
  const Glyph = ICONS[name];
  // Order matters: an explicit colour is always data or brand, and data must
  // never be overridden by a theme.
  const resolved = color ?? (tone ? tones[tone] : tones.muted);
  return <Glyph size={size} color={resolved} strokeWidth={strokeWidth} {...props} />;
}

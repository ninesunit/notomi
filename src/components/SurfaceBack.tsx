import { Link } from 'expo-router';
import { Button } from './ui';

export function SurfaceBack({ href, label = 'Back' }: { href: string; label?: string }) {
  return (
    <Link href={href as never} asChild>
      <Button label={label} icon="arrow-left" variant="ghost" size="sm" />
    </Link>
  );
}

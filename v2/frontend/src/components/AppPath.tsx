/** Chaîne de dépendance entre applications (A, puis B dont A dépend, puis C...), chaque maillon cliquable. */
import { Fragment } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { Ref } from '../lib/api';
import { appHref } from '../lib/links';
import { cn } from '../lib/cn';
import { TONE_CLASSES, isKnownState, stateMeta } from '../lib/status';

/** `failingState` : état du dernier maillon (celui qui menace la chaîne), coloré selon cet état. */
export function AppPath({ path, label, failingState, className }: { path: Ref[]; label: string; failingState?: string | null; className?: string }) {
  const tone = isKnownState(failingState) ? TONE_CLASSES[stateMeta(failingState).tone] : null;
  const last = tone ? cn(tone.soft, tone.text, 'font-medium') : 'bg-surface-3 font-medium text-ink';
  return (
    <ol aria-label={label} className={cn('flex flex-wrap items-center gap-x-1 gap-y-1 text-xs', className)}>
      {path.map((p, i) => (
        <Fragment key={`${p.id}-${i}`}>
          {i > 0 && (
            <li aria-hidden className="text-ink-3">
              <ChevronRight size={13} />
            </li>
          )}
          <li className="min-w-0">
            <Link
              to={appHref(p.id)}
              className={cn('inline-block max-w-full truncate rounded-sm px-1.5 py-0.5 hover:underline', i === path.length - 1 ? last : 'bg-surface-3 text-ink')}
            >
              {p.name}
            </Link>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

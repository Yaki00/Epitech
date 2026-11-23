import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-transparent hover:bg-accent-hover',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink',
  danger: 'bg-surface text-down border-down/40 hover:bg-down-soft',
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8.5 px-3 text-[13px] gap-2',
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** bouton icône seule : `label` sert d'aria-label et d'infobulle */
  iconOnly?: boolean;
  label?: string;
  className?: string;
  children?: ReactNode;
}

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    /** lien interne (React Router) */
    to?: string;
    /** lien externe, ouvert dans un nouvel onglet */
    href?: string;
  };

/** Bouton ; `to` rend un lien interne, `href` un lien externe (nouvel onglet). */
export function Button({ variant = 'secondary', size = 'md', icon: Icon, iconOnly, label, className, children, to, href, type, ...rest }: ButtonProps) {
  const cls = cn(
    'inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    iconOnly && (size === 'sm' ? 'w-7 px-0' : 'w-8.5 px-0'),
    className,
  );
  const content = (
    <>
      {Icon && <Icon aria-hidden size={size === 'sm' ? 14 : 16} strokeWidth={1.75} />}
      {iconOnly ? <span className="sr-only">{label}</span> : children}
    </>
  );
  const a11y = iconOnly ? { 'aria-label': label, title: label } : label ? { title: label } : {};
  if (to !== undefined) {
    return (
      <Link to={to} className={cls} {...a11y}>
        {content}
      </Link>
    );
  }
  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls} {...a11y}>
        {content}
      </a>
    );
  }
  return (
    <button type={type ?? 'button'} className={cls} {...a11y} {...rest}>
      {content}
    </button>
  );
}

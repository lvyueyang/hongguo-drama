import type * as React from 'react';
import { cn } from './cn.ts';

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.ComponentProps<'span'> & { tone?: 'neutral' | 'accent' | 'success' }) {
  const tones = {
    neutral: 'bg-selection text-secondary-text',
    accent: 'bg-accent text-white',
    success: 'bg-success text-white',
  } as const;
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[var(--font-size-caption)] font-medium',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

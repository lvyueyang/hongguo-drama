import type * as React from 'react';
import { cn } from './cn.ts';

export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        'h-8 w-full rounded-[var(--radius-control)] border border-border-subtle bg-surface px-2.5 text-[var(--font-size-label)] text-primary-text placeholder:text-muted focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
}

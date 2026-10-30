import { cn } from './cn.ts';

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-[var(--radius-control)] bg-selection', className)}
      {...props}
    />
  );
}

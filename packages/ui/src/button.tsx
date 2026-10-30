import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from './cn.ts';

/**
 * shadcn/ui 风格的按钮：`data-slot` + cva 变体 + 无 forwardRef（React 19 直接透传 props）。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 cursor-default',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent-hover',
        outline: 'border border-border-subtle bg-surface text-primary-text hover:bg-selection',
        ghost: 'text-secondary-text hover:bg-selection hover:text-primary-text',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        sm: 'h-7 px-2.5 text-[var(--font-size-caption)]',
        md: 'h-8 px-3 text-[var(--font-size-label)]',
        lg: 'h-10 px-4 text-[var(--font-size-body)]',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-accent text-white hover:bg-accent/90",
        secondary: "border border-border bg-surface text-text hover:bg-surface-hover",
        ghost: "text-muted hover:bg-surface-hover hover:text-text",
        destructive: "bg-negative text-white hover:bg-negative/90",
        link: "text-accent hover:underline px-0",
      },
      size: { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4 text-sm", icon: "size-8" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> { asChild?: boolean }

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const C = asChild ? Slot : "button";
  return <C className={cn(button({ variant, size }), className)} {...props} />;
}

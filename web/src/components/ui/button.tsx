import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** 按钮三档 + 一个危险档。
 *
 * **危险档有形状,不只有颜色**:红底 + ⚡,而且调用方必须给它配一个预览步。
 * 面板上永远只有一个红按钮 —— 红色一旦廉价,它就不再是刹车。
 */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium " +
  "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1",
  {
    variants: {
      variant: {
        primary: "bg-zinc-900 text-white hover:bg-zinc-800",
        secondary: "bg-white text-zinc-900 border border-zinc-300 hover:bg-zinc-50",
        ghost: "bg-transparent text-zinc-700 hover:bg-zinc-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        default: "h-9 px-3 text-sm",
        sm: "h-7 px-2 text-xs",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export function Button({
  className, variant, size, asChild, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
   VariantProps<typeof button> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(button({ variant, size }), className)} {...props} />;
}

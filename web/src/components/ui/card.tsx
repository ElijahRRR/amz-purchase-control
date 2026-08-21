import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-white border border-zinc-200 rounded-lg", className)} {...props} />;
}

/** 卡片头:固定 44px,底部一条内边框。设计里所有卡片都长这样。 */
export function CardHead({ className, children, right }: {
  className?: string; children: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <header className={cn(
      "h-chead flex items-center justify-between px-4 border-b border-zinc-100", className,
    )}>
      <h2 className="text-[13px] font-medium text-zinc-900">{children}</h2>
      {right}
    </header>
  );
}

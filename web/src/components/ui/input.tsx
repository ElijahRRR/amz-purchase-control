import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-7 px-2 rounded-md border border-zinc-200 bg-white text-xs text-zinc-800",
        "placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-900",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "px-2.5 py-2 rounded-md border border-zinc-200 bg-white font-mono text-xs leading-relaxed",
        "text-zinc-800 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-900",
        className,
      )}
      {...props}
    />
  );
}

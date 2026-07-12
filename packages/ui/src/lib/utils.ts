import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn/ui class-merge helper, re-exported from the workspace
// package so every app imports the same one: @sentinel-act/ui/lib/utils
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

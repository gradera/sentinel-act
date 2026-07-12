"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Wraps next-themes' provider so the operator queue's dark mode toggle
 * (Spec 14 Task 2) is a real, localStorage-persisted preference, not just
 * OS-preference following, and so SSR doesn't flash the wrong theme.
 */
export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}

"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import { useUnsavedCloseGuard } from "@sentinel-act/ui/lib/use-unsaved-close-guard";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="sheet-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 flex flex-col",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm"
      }
    },
    defaultVariants: { side: "right" }
  }
);

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  showCloseButton?: boolean;
  /** Spec 14 FR-23: when true (e.g. a Tier C rationale Textarea has
   *  uncommitted text), Escape and outside-click show an inline
   *  discard-confirm instead of closing the sheet immediately — this is
   *  the primary place FR-23 matters, since SignOffPanel (Spec 09) is a
   *  Sheet, not a Dialog. */
  hasUnsavedChanges?: boolean;
}

const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  (
    { side = "right", className, children, showCloseButton = true, hasUnsavedChanges, onEscapeKeyDown, onPointerDownOutside, ...props },
    ref
  ) => {
    const { confirming, guardEscape, guardOutsideInteract, cancelDiscard } = useUnsavedCloseGuard(hasUnsavedChanges);

    return (
      <SheetPortal>
        <SheetOverlay />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="sheet-content"
          onEscapeKeyDown={(e) => {
            guardEscape(e);
            onEscapeKeyDown?.(e);
          }}
          onPointerDownOutside={(e) => {
            guardOutsideInteract(e);
            onPointerDownOutside?.(e);
          }}
          className={cn(sheetVariants({ side }), className)}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
          {confirming && (
            <div
              role="alertdialog"
              aria-label="Discard unsaved changes?"
              data-slot="sheet-unsaved-confirm"
              className="absolute inset-x-4 bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--risk-escalate))]/40 bg-[hsl(var(--risk-escalate))]/10 p-3 text-sm"
            >
              <span>You have unsaved changes. Discard them?</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cancelDiscard}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-secondary"
                >
                  Keep editing
                </button>
                <DialogPrimitive.Close asChild>
                  <button
                    type="button"
                    className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                  >
                    Discard
                  </button>
                </DialogPrimitive.Close>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </SheetPortal>
    );
  }
);
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="sheet-header" className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} data-slot="sheet-title" className={cn("text-lg font-semibold text-foreground", className)} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };

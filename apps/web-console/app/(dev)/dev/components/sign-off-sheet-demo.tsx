"use client";

import * as React from "react";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@sentinel-act/ui/components/ui/sheet";
import { Button } from "@sentinel-act/ui/components/ui/button";
import { Label } from "@sentinel-act/ui/components/ui/label";
import { Textarea } from "@sentinel-act/ui/components/ui/textarea";

/**
 * Live demo of Spec 14 FR-23: type a rationale, then press Escape —
 * the sheet shows a discard-confirm instead of closing. Wired to real
 * Textarea state (not a static `hasUnsavedChanges` prop) so this
 * example actually exercises the guard, not just renders its markup.
 */
export function SignOffSheetDemo() {
  const [rationale, setRationale] = React.useState("");

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open sign-off sheet</Button>
      </SheetTrigger>
      <SheetContent hasUnsavedChanges={rationale.trim().length > 0}>
        <SheetHeader>
          <SheetTitle>Sign off — Tier C</SheetTitle>
          <SheetDescription>
            Rationale is required before you can approve this item. Type something, then press Escape.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-2 px-4">
          <Label htmlFor="dev-rationale">Rationale</Label>
          <Textarea
            id="dev-rationale"
            placeholder="Explain your decision..."
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
        </div>
        <SheetFooter>
          <Button variant="outline">Decline</Button>
          <Button disabled={rationale.trim().length === 0}>Approve</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

import { notFound } from "next/navigation";

import { SignOffSheetDemo } from "./sign-off-sheet-demo";
import { Button } from "@sentinel-act/ui/components/ui/button";
import { Badge } from "@sentinel-act/ui/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@sentinel-act/ui/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@sentinel-act/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel
} from "@sentinel-act/ui/components/ui/alert-dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@sentinel-act/ui/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@sentinel-act/ui/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@sentinel-act/ui/components/ui/tooltip";
import { Textarea } from "@sentinel-act/ui/components/ui/textarea";
import { Label } from "@sentinel-act/ui/components/ui/label";
import { Skeleton } from "@sentinel-act/ui/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@sentinel-act/ui/components/ui/avatar";
import { Separator } from "@sentinel-act/ui/components/ui/separator";
import { ScrollArea } from "@sentinel-act/ui/components/ui/scroll-area";
import { Alert, AlertTitle, AlertDescription } from "@sentinel-act/ui/components/ui/alert";

import { RiskTierBadge } from "@sentinel-act/ui/components/governance/risk-tier-badge";
import { ConfidenceBadge } from "@sentinel-act/ui/components/governance/confidence-badge";
import { LineageBreadcrumb } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";
import { UrgencyBadge } from "@sentinel-act/ui/components/governance/urgency-badge";
import { RedlineDiff, type DiffField } from "@sentinel-act/ui/components/governance/redline-diff";
import { IndependenceGate } from "@sentinel-act/ui/components/governance/independence-gate";
import { EvidenceUploader } from "@sentinel-act/ui/components/governance/evidence-uploader";
import { ExceptionAlert } from "@sentinel-act/ui/components/governance/exception-alert";

import type { HumanReview, EvidenceArtifact } from "@sentinel-act/graph-schema";

// Spec 14 §5.3 / FR-24 / NFR-6: a zero-new-infra component preview
// surface, reused-from-the-app's-own-build (no Storybook, see Spec 14
// §13). Every example below is inline mock data matching
// @sentinel-act/graph-schema shapes — no live Neo4j/API calls, and this
// route must 404 outside development.
export default function DevComponentsPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-12 px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">packages/ui component preview</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only route (Spec 14 FR-24). 404s in production. Every primitive and governance composite from
          Spec 14, at least one example each.
        </p>
      </header>

      <Section title="Button">
        <div className="flex flex-wrap gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </Section>

      <Section title="Card">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Circular 2026/07/CIR/014</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Example card content.</CardContent>
        </Card>
      </Section>

      <Section title="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm reject</DialogTitle>
              <DialogDescription>This action cannot be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">Cancel</Button>
              <Button variant="destructive">Reject</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      <Section title="Sheet" description="Live FR-23 demo: type a rationale, then press Escape.">
        <SignOffSheetDemo />
      </Section>

      <Section title="AlertDialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Decline with confirmation</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Decline this obligation?</AlertDialogTitle>
              <AlertDialogDescription>You cannot revise this decision after submitting.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Confirm decline</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Section>

      <Section title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Obligation</TableHead>
              <TableHead>Risk tier</TableHead>
              <TableHead>Urgency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Quarterly disclosure filing</TableCell>
              <TableCell>
                <RiskTierBadge tier="B" />
              </TableCell>
              <TableCell>
                <UrgencyBadge level="now" detail="Due in 2h" />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="chat" className="max-w-md">
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="history">Sourced answers</TabsTrigger>
          </TabsList>
          <TabsContent value="chat">Chat panel content.</TabsContent>
          <TabsContent value="history">Sourced answer history.</TabsContent>
        </Tabs>
      </Section>

      <Section title="Tooltip">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Why is this Tier C?</Button>
            </TooltipTrigger>
            <TooltipContent>Penalty-bearing, deadline-bound, and overwrites a live obligation.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Section>

      <Section title="Textarea + Label">
        <div className="grid max-w-md gap-2">
          <Label htmlFor="dev-textarea">Rationale</Label>
          <Textarea id="dev-textarea" placeholder="Required at Tier C..." />
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="max-w-md space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-10 w-full" />
        </div>
      </Section>

      <Section title="Avatar">
        <div className="flex gap-2">
          <Avatar>
            <AvatarFallback>CO</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>SC</AvatarFallback>
          </Avatar>
        </div>
      </Section>

      <Section title="Separator">
        <div className="max-w-md">
          <p className="text-sm">Above</p>
          <Separator className="my-2" />
          <p className="text-sm">Below</p>
        </div>
      </Section>

      <Section title="ScrollArea">
        <ScrollArea className="h-32 max-w-md rounded-md border p-3">
          {Array.from({ length: 20 }).map((_, i) => (
            <p key={i} className="text-sm">
              Scrollable line {i + 1}
            </p>
          ))}
        </ScrollArea>
      </Section>

      <Section title="Alert">
        <div className="max-w-md space-y-2">
          <Alert>
            <AlertTitle>Default alert</AlertTitle>
            <AlertDescription>Base primitive ExceptionAlert is built on.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Destructive alert</AlertTitle>
            <AlertDescription>Used for the escalate/sla-breach treatments.</AlertDescription>
          </Alert>
        </div>
      </Section>

      <Section title="Toaster / toast()" description="Global <Toaster /> is mounted in app/layout.tsx.">
        <p className="text-sm text-muted-foreground">See app/layout.tsx — toast() is called from sign-off flows.</p>
      </Section>

      <Separator />

      <h2 className="text-xl font-bold">Governance composites</h2>

      <Section title="RiskTierBadge">
        <div className="flex flex-wrap gap-2">
          <RiskTierBadge tier="A" />
          <RiskTierBadge tier="B" />
          <RiskTierBadge tier="C" />
          <RiskTierBadge tier="ESCALATE" />
        </div>
      </Section>

      <Section title="ConfidenceBadge">
        <div className="flex flex-wrap gap-2">
          <ConfidenceBadge score={0.92} />
          <ConfidenceBadge score={0.71} />
          <ConfidenceBadge score={0.45} />
          <ConfidenceBadge score={0.88} label="Grounding" />
        </div>
      </Section>

      <Section title="LineageBreadcrumb">
        <LineageBreadcrumb
          steps={[
            { label: "Circular 2026/07/CIR/014", href: "#" },
            { label: "Clause 4.2", href: "#" },
            { label: "Obligation OB-1029", href: "#" },
            { label: "ProcessTask PT-2201" }
          ]}
        />
      </Section>

      <Section title="UrgencyBadge">
        <div className="flex flex-wrap gap-2">
          <UrgencyBadge level="now" detail="Due in 2h 15m" />
          <UrgencyBadge level="in-motion" detail="Due in 3 days" />
          <UrgencyBadge level="archive" />
        </div>
      </Section>

      <Section title="RedlineDiff" description="kind: value (default) and kind: text word-level diffing.">
        <div className="space-y-6">
          <RedlineDiff title="ProcessTask update — 3 changed, 2 unchanged" fields={redlineFieldsChanged} />
          <RedlineDiff
            title="New ProcessTask — no prior version"
            fields={redlineFieldsNew}
            emptyOldLabel="New ProcessTask — no prior version to compare."
          />
        </div>
      </Section>

      <Section title="IndependenceGate" description="All three states shown for the checker role.">
        <div className="space-y-4">
          <IndependenceGate role="maker" state="awaiting_assignment">
            <p className="text-sm">Locked, read-only detail view.</p>
          </IndependenceGate>
          <IndependenceGate role="checker" state="in_independent_review">
            <p className="text-sm">Full detail view, identical to a first-time reviewer.</p>
          </IndependenceGate>
          <IndependenceGate role="checker" state="revealed" reviews={[mockMakerReview, mockCheckerReview]}>
            <p className="text-sm">Post-decision detail view.</p>
          </IndependenceGate>
        </div>
      </Section>

      <Section title="EvidenceUploader">
        <EvidenceUploader
          taskId="task-2201"
          existing={[mockEvidenceArtifact]}
          onUpload={async () => {
            "use server";
          }}
        />
      </Section>

      <Section title="ExceptionAlert" description="All three severities.">
        <div className="space-y-3">
          <ExceptionAlert
            severity="escalate"
            title="Contradiction detected"
            description="This obligation conflicts with a currently live obligation."
            detail={
              <RedlineDiff
                title="Obligation.deadline_rule"
                fields={[
                  {
                    key: "deadline_rule",
                    label: "Deadline rule",
                    oldValue: "3 days from trigger event",
                    newValue: "5 days from trigger event",
                    kind: "text"
                  }
                ]}
              />
            }
            actions={
              <>
                <Button variant="destructive">Escalate to Tier C</Button>
                <Button variant="outline">Reject</Button>
              </>
            }
          />
          <ExceptionAlert
            severity="sla-breach"
            title="SLA missed, reassigned from J. Rao"
            description="This item breached its review SLA and was auto-escalated to you."
          />
          <ExceptionAlert
            severity="warning"
            title="First-seen obligation type"
            description="No prior ProcessTask exists for this obligation category."
          />
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" aria-labelledby={`section-${title}`}>
      <div>
        <h3 id={`section-${title}`} className="text-base font-semibold">
          {title}
        </h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const redlineFieldsChanged: DiffField[] = [
  { key: "owner_role", label: "Owner role", oldValue: "Compliance Officer", newValue: "Senior Compliance Officer", kind: "value" },
  {
    key: "task_name",
    label: "Task name",
    oldValue: "File quarterly report",
    newValue: "File quarterly report to SEBI within 3 days",
    kind: "text"
  },
  { key: "risk_score", label: "Risk score", oldValue: "0.42", newValue: "0.81", kind: "value" },
  { key: "sla_hours", label: "SLA (hours)", oldValue: 24, newValue: 24, kind: "value" },
  { key: "system_touchpoint", label: "System touchpoint", oldValue: "Filing portal", newValue: "Filing portal", kind: "value" }
];

const redlineFieldsNew: DiffField[] = [
  { key: "owner_role", label: "Owner role", oldValue: null, newValue: "Compliance Officer" },
  { key: "task_name", label: "Task name", oldValue: null, newValue: "File quarterly disclosure" },
  { key: "sla_hours", label: "SLA (hours)", oldValue: null, newValue: 48 }
];

const mockMakerReview: HumanReview = {
  review_id: "rev-1001",
  obligation_id: "ob-1029",
  reviewer_id: "j.rao@example.com",
  tier: "C",
  decision: "approve",
  rationale: "Matches clause 4.2 wording exactly; no penalty ambiguity.",
  decided_at: "2026-07-10T10:00:00.000Z",
  valid_from: "2026-07-10",
  valid_to: null,
  recorded_at: "2026-07-10T10:00:00.000Z"
};

const mockCheckerReview: HumanReview = {
  review_id: "rev-1002",
  obligation_id: "ob-1029",
  reviewer_id: "s.iyer@example.com",
  tier: "C",
  decision: "approve",
  rationale: "Independently verified against the source circular; concur.",
  decided_at: "2026-07-10T14:30:00.000Z",
  valid_from: "2026-07-10",
  valid_to: null,
  recorded_at: "2026-07-10T14:30:00.000Z"
};

const mockEvidenceArtifact: EvidenceArtifact = {
  evidence_id: "ev-3001",
  task_id: "task-2201",
  type: "pdf",
  hash: "deadbeefcafefeed00112233445566778899aabbccddeeff0011223344",
  uploaded_at: "2026-07-05T00:00:00.000Z",
  uploaded_by: "officer@example.com",
  valid_from: "2026-07-05",
  valid_to: null,
  recorded_at: "2026-07-05T00:00:00.000Z"
};

"use client";

import * as React from "react";
import { Upload, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import { Label } from "@sentinel-act/ui/components/ui/label";
import { Button } from "@sentinel-act/ui/components/ui/button";
import type { EvidenceArtifact } from "@sentinel-act/graph-schema";

/**
 * EvidenceUploader — presentational + client-side hashing only, no
 * network call of its own (Spec 14 NFR-4). Validates type/size before
 * calling `onUpload`, computes SHA-256 via SubtleCrypto so a reviewer
 * can visually confirm the artifact hash before/while it uploads,
 * mirroring `EvidenceArtifact.hash` rather than inventing a new field.
 */

export interface EvidenceUploaderProps {
  /** ProcessTask.task_id this evidence attaches to. Not rendered
   *  directly (this component has no network call to scope by it) —
   *  exposed so callers can correlate the component instance with the
   *  task it's wired to, and surfaced as `data-task-id` for testing. */
  taskId: string;
  existing?: EvidenceArtifact[];
  accept?: string[];
  maxSizeMb?: number;
  onUpload: (file: File, computedSha256Hex: string) => Promise<void> | void;
  disabled?: boolean;
  className?: string;
}

const DEFAULT_ACCEPT = [".pdf", ".png", ".jpg", ".jpeg", ".csv", ".xlsx"];
const DEFAULT_MAX_SIZE_MB = 25;

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", buffer);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

type Status = "idle" | "hashing" | "uploading" | "done" | "error";

export function EvidenceUploader({
  taskId,
  existing = [],
  accept = DEFAULT_ACCEPT,
  maxSizeMb = DEFAULT_MAX_SIZE_MB,
  onUpload,
  disabled,
  className
}: EvidenceUploaderProps) {
  const inputId = React.useId();
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [hashHex, setHashHex] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status>("idle");
  const [dragOver, setDragOver] = React.useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    setHashHex(null);

    // FR-17: reject before any callback fires, inline field-level error
    // naming the specific reason — never a toast.
    const ext = getExtension(file.name);
    if (!accept.includes(ext)) {
      setSelectedFile(file);
      setError(`File type ${ext || "unknown"} is not accepted.`);
      setStatus("error");
      return;
    }

    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > maxSizeMb) {
      setSelectedFile(file);
      setError(`File exceeds ${maxSizeMb}MB limit.`);
      setStatus("error");
      return;
    }

    setSelectedFile(file);
    setStatus("hashing");
    try {
      // FR-18: SHA-256 client-side via SubtleCrypto, first 8 hex chars
      // shown next to the filename.
      const hex = await sha256Hex(file);
      setHashHex(hex);
      setStatus("uploading");
      await onUpload(file, hex);
      setStatus("done");
    } catch (err) {
      // §8 edge case: onUpload rejecting keeps the selected File in
      // local state (not cleared) so a caller-driven retry doesn't
      // require re-picking the file.
      setStatus("error");
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <div className={cn("space-y-3", className)} data-slot="evidence-uploader" data-task-id={taskId}>
      <Label htmlFor={inputId}>Evidence file</Label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm text-muted-foreground transition-colors",
          dragOver && "border-ring bg-secondary",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <Upload className="h-5 w-5" aria-hidden="true" />
        <p>Drag and drop a file here, or</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => document.getElementById(inputId)?.click()}
        >
          Choose file
        </Button>
        <input
          id={inputId}
          type="file"
          className="sr-only"
          accept={accept.join(",")}
          disabled={disabled}
          onChange={onInputChange}
        />
        <p className="text-xs">
          Accepted: {accept.join(", ")} · Max {maxSizeMb}MB
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-sm text-[hsl(var(--risk-escalate))]"
          data-slot="evidence-uploader-error"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {selectedFile && !error && (
        <div className="flex items-center gap-2 rounded-md border p-2 text-sm" data-slot="evidence-uploader-selected">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{selectedFile.name}</span>
          {hashHex && <span className="text-xs text-muted-foreground">sha256:{hashHex.slice(0, 8)}</span>}
          {status === "done" && (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[hsl(var(--risk-a))]" aria-hidden="true" />
          )}
        </div>
      )}

      {existing.length > 0 && (
        <div className="space-y-1" data-slot="evidence-uploader-existing">
          <p className="text-xs font-medium text-muted-foreground">Existing evidence</p>
          <ul className="space-y-1">
            {existing.map((artifact) => (
              <li key={artifact.evidence_id} className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>{artifact.type}</span>
                <span className="text-xs text-muted-foreground">sha256:{artifact.hash.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

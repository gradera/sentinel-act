import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EvidenceUploader } from "./evidence-uploader";

function makeFile(name: string, sizeBytes: number, type = "application/pdf"): File {
  const file = new File([new Uint8Array(sizeBytes)], name, { type });
  return file;
}

beforeEach(() => {
  // jsdom doesn't implement SubtleCrypto; mock a deterministic digest.
  const fakeHashBytes = new Uint8Array(32).fill(0xab);
  Object.defineProperty(window, "crypto", {
    value: {
      subtle: {
        digest: vi.fn().mockResolvedValue(fakeHashBytes.buffer)
      }
    },
    configurable: true
  });
});

function getFileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("EvidenceUploader (Spec 14 FR-17, FR-18)", () => {
  it("rejects a disallowed file extension before calling onUpload", async () => {
    const onUpload = vi.fn();
    render(<EvidenceUploader taskId="task-1" onUpload={onUpload} />);
    const file = makeFile("malware.exe", 1024, "application/octet-stream");
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("File type .exe is not accepted."));
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before calling onUpload or hashing", async () => {
    const onUpload = vi.fn();
    render(<EvidenceUploader taskId="task-1" maxSizeMb={25} onUpload={onUpload} />);
    const file = makeFile("big.pdf", 30 * 1024 * 1024);
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("File exceeds 25MB limit."));
    expect(onUpload).not.toHaveBeenCalled();
    expect(window.crypto.subtle.digest).not.toHaveBeenCalled();
  });

  it("computes and displays a truncated SHA-256 for a valid file, then calls onUpload", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<EvidenceUploader taskId="task-1" onUpload={onUpload} />);
    const file = makeFile("evidence.pdf", 1024);
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload).toHaveBeenCalledWith(file, "ab".repeat(32));
    await waitFor(() => expect(screen.getByText("sha256:abababab")).toBeInTheDocument());
  });

  it("keeps the selected file in local state if onUpload rejects, for caller-driven retry", async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error("Network error"));
    render(<EvidenceUploader taskId="task-1" onUpload={onUpload} />);
    const file = makeFile("evidence.pdf", 1024);
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Network error"));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("renders existing evidence artifacts", () => {
    render(
      <EvidenceUploader
        taskId="task-1"
        onUpload={vi.fn()}
        existing={[
          {
            evidence_id: "ev-1",
            task_id: "task-1",
            type: "pdf",
            hash: "deadbeefcafefeed00112233445566778899aabbccddeeff0011223344",
            uploaded_at: "2026-07-01T00:00:00.000Z",
            uploaded_by: "officer@example.com",
            valid_from: "2026-07-01",
            valid_to: null,
            recorded_at: "2026-07-01T00:00:00.000Z"
          }
        ]}
      />
    );
    expect(screen.getByText("sha256:deadbeef")).toBeInTheDocument();
  });

  it("has an accessible label associated with the file input (FR-21)", () => {
    render(<EvidenceUploader taskId="task-1" onUpload={vi.fn()} />);
    expect(screen.getByLabelText("Evidence file")).toBeInTheDocument();
  });
});

// EvidenceArtifactRepository — never superseded in place; base
// GraphRepository contract only (spec §5.4).
import type { ManagedTransaction } from "neo4j-driver";
import type { EvidenceArtifact } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";

export class EvidenceArtifactRepository extends BaseRepository<EvidenceArtifact, "evidence_id"> {
  readonly label = "EvidenceArtifact";
  readonly idField = "evidence_id" as const;

  async create(input: CreateInput<EvidenceArtifact>, tx?: ManagedTransaction): Promise<EvidenceArtifact> {
    const start = Date.now();
    const props = this.toCreateParams(input);
    try {
      const record = await this.withWrite(tx, async (innerTx) => {
        const result = await innerTx.run(this.buildCreateCypher(), { props });
        return result.records[0];
      });
      const value = this.deserialize(record.get("n").properties);
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    }
  }
}

// HumanReviewRepository — never superseded in place; base
// GraphRepository contract only (spec §5.4). The sole enforcement point
// for Tier C maker-checker independence lives in a later spec (07's
// recordHumanReview) — this repository only persists the fact once that
// layer has decided to write it.
import type { ManagedTransaction } from "neo4j-driver";
import type { HumanReview } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";

export class HumanReviewRepository extends BaseRepository<HumanReview, "review_id"> {
  readonly label = "HumanReview";
  readonly idField = "review_id" as const;

  protected override get nullableFields(): readonly string[] {
    return [...super.nullableFields, "rationale"];
  }

  async create(input: CreateInput<HumanReview>, tx?: ManagedTransaction): Promise<HumanReview> {
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

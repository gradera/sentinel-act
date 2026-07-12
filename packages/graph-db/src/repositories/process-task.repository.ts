// ProcessTaskRepository. ProcessTask is never superseded in place — a
// changed task is a new ProcessTask linked via a new MAPPED_TO edge from
// the new Obligation (spec §5.4), so this repository implements only the
// base GraphRepository contract.
import type { ManagedTransaction } from "neo4j-driver";
import type { ProcessTask } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";

export class ProcessTaskRepository extends BaseRepository<ProcessTask, "task_id"> {
  readonly label = "ProcessTask";
  readonly idField = "task_id" as const;

  async create(input: CreateInput<ProcessTask>, tx?: ManagedTransaction): Promise<ProcessTask> {
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

import type { MutationExecutionContext } from "../intent-types.js";

export interface WriteAdapterResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WriteAdapter {
  writeConfig(params: {
    storeId: string;
    payload: Record<string, unknown>;
    executionContext?: MutationExecutionContext;
  }): Promise<WriteAdapterResult>;
}

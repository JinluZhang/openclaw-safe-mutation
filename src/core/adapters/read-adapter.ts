import type { MutationExecutionContext } from "../intent-types.js";

export interface ReadAdapter {
  readCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>>;
}

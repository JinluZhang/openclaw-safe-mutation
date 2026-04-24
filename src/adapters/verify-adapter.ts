import type { MutationExecutionContext } from "../intent-types.js";

export interface VerifyAdapter {
  verifyCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>>;
}

export type TextPlanAction =
  | {
      kind: "approve";
      planId?: string;
    }
  | {
      kind: "cancel";
      planId?: string;
    };

const ACTION_PATTERN =
  /^(确认执行|确认|批准|同意|取消变更|取消|放弃)(?:\s*(plan_[A-Za-z0-9_-]+))?$/u;

export function parseTextPlanAction(
  text: string | undefined
): TextPlanAction | undefined {
  const normalized = text?.trim().replace(/\s+/gu, " ");

  if (!normalized) {
    return;
  }

  const match = normalized.match(ACTION_PATTERN);

  if (!match) {
    return;
  }

  const keyword = match[1];
  const planId = match[2];

  if (
    keyword === "确认" ||
    keyword === "确认执行" ||
    keyword === "批准" ||
    keyword === "同意"
  ) {
    return {
      kind: "approve",
      ...(planId ? { planId } : {})
    };
  }

  return {
    kind: "cancel",
    ...(planId ? { planId } : {})
  };
}

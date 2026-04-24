import type { MutationPlan } from "../intent-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "(empty)";
  }

  if (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.threshold === "number" &&
        typeof item.reduction === "number"
    )
  ) {
    return value
      .map((item) => `${item.threshold}-${item.reduction}`)
      .join(", ");
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

export function renderMutationPlanStatusForText(plan: MutationPlan): string {
  const lines = [`Plan: ${plan.planId}`, `状态：${plan.status}`];

  if (plan.result?.error) {
    lines.push(`结果：${plan.result.error}`);
  } else if (plan.result?.verifySucceeded) {
    lines.push("结果：写入并回读验证成功");
  }

  return lines.join("\n");
}

export function renderMutationPlanForText(plan: MutationPlan): string {
  const lines = [
    `Plan: ${plan.planId}`,
    `状态：${plan.status}`,
    `原始请求：${plan.userText}`,
    `系统理解：${plan.interpretationText}`,
    `门店：${plan.storeId}`
  ];

  lines.push("变更：");

  for (const diffItem of plan.diffItems) {
    lines.push(
      `- ${diffItem.label}: ${formatValue(diffItem.before)} -> ${formatValue(diffItem.after)}`
    );
  }

  lines.push("说明：其余参数保持当前值不变");

  if (plan.status === "pending_ack") {
    lines.push('确认方式：回复“确认”后由系统直接执行');
    lines.push('取消方式：回复“取消”放弃本次变更');
    lines.push(
      `多计划指定：若当前会话有多个待确认计划，请回复“确认 ${plan.planId}”或“取消 ${plan.planId}”`
    );
  }

  return lines.join("\n");
}

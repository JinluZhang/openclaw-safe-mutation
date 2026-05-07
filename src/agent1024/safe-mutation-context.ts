import type { MutationPlan } from "../core/intent-types.js";

function getFrozenWriteSummary(plan: MutationPlan): string {
  const invocation = plan.executionContext?.writeInvocation;

  if (invocation?.kind === "shell") {
    return `冻结命令：${invocation.command}`;
  }

  if (invocation?.kind === "http") {
    return `冻结请求：${invocation.method ?? "GET"} ${invocation.url}`;
  }

  return `业务摘要：${plan.interpretationText}`;
}

function summarizeValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "无";
  }

  if (typeof value === "string") {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }

  const json = JSON.stringify(value);
  return json.length > 180 ? `${json.slice(0, 177)}...` : json;
}

function getVerifySummary(plan: MutationPlan): string {
  if (plan.result?.verifySucceeded) {
    return "写入并回读验证成功";
  }

  if (plan.result?.verifySnapshot !== undefined) {
    return summarizeValue(plan.result.verifySnapshot);
  }

  if (plan.result?.verifySucceeded === false) {
    return "回读验证未通过";
  }

  return "无";
}

function getWriteSummary(plan: MutationPlan): string {
  if (plan.result?.writeStdout || plan.result?.writeStderr) {
    return summarizeValue({
      stdout: plan.result.writeStdout,
      stderr: plan.result.writeStderr
    });
  }

  if (plan.result?.writeSucceeded !== undefined) {
    return plan.result.writeSucceeded ? "写入接口返回成功" : "写入接口未成功";
  }

  return "无";
}

export function buildSafeMutationContext(params: {
  action: "approve" | "cancel";
  plan: MutationPlan;
}): string {
  const plan = params.plan;
  const writeSummary = getFrozenWriteSummary(plan);

  if (params.action === "cancel") {
    return `用户取消了受保护变更 ${plan.planId}。Safe Mutation 未执行写操作。状态：${plan.status}。${writeSummary}。请停止该变更相关后续步骤，并向用户确认已取消。`;
  }

  if (plan.status === "succeeded") {
    return `用户确认了受保护变更 ${plan.planId}。Safe Mutation 已执行冻结写操作。状态：succeeded。${writeSummary}。验证结果：${getVerifySummary(plan)}。请基于该结果继续完成原任务，不要重复调用同一写工具。`;
  }

  if (plan.status === "conflict") {
    return `用户确认了受保护变更 ${plan.planId}，但 Safe Mutation 未执行写操作。状态：conflict。原因：执行前状态与确认单生成时不一致，可能已有其他人或系统修改了同一业务对象。${writeSummary}。请向用户说明本次变更未执行，并建议重新发起变更确认；不要继续执行该写操作。`;
  }

  if (plan.status === "failed") {
    return `用户确认了受保护变更 ${plan.planId}，但 Safe Mutation 未能确认最终写入成功。状态：failed。原因：${summarizeValue(plan.result?.error)}。${writeSummary}。写入接口返回：${getWriteSummary(plan)}。回读验证：${getVerifySummary(plan)}。请向用户说明变更结果未确认成功，不要重复调用同一写工具；如需继续，应重新发起新的受保护变更流程或转人工排查。`;
  }

  if (plan.status === "expired") {
    return `用户确认了受保护变更 ${plan.planId}，但该确认单已过期，Safe Mutation 未执行写操作。状态：expired。${writeSummary}。请向用户说明原确认单已失效，如仍需变更，需要重新发起操作并生成新的确认单；不要继续执行该写操作。`;
  }

  if (plan.status === "cancelled") {
    return `用户确认了受保护变更 ${plan.planId}，但该确认单已取消，Safe Mutation 未执行写操作。状态：cancelled。${writeSummary}。请向用户说明本次变更已取消；不要继续执行该写操作。`;
  }

  return `用户确认了受保护变更 ${plan.planId}。当前状态：${plan.status}。${writeSummary}。请基于该状态继续任务，不要重复调用同一写工具。`;
}

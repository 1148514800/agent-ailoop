export const routerTaskPrompt = "读取本轮 context.json 中的事件和 detail，按后缀处理。.direct 直接执行并验证。.plan 先阅读项目、制定计划，再执行并验证。只操作本规则授权的目录，并遵守权限和审批机制。";

export function variantPrompt(base: string | undefined) {
  const projectNotes = base?.replace(/router\.(?:task|plan|profile|project)\b[.a-z0-9*-]*/gi, (type) => {
    const suffix = type.match(/\.(direct|plan)$/i)?.[1];
    return suffix ? "本轮 ." + suffix.toLowerCase() + " 事件" : "本轮任务事件";
  });
  return [routerTaskPrompt, projectNotes === routerTaskPrompt ? undefined : projectNotes].filter(Boolean).join("\n\n");
}

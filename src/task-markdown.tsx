import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const responseText = (value: string) => value.replace(
  /^ {0,3}(?:```+|~~~+)\s*agent-autoloop[^\n]*(?:\n|$)[\s\S]*?(?:^ {0,3}(?:```+|~~~+) *$|(?![\s\S]))/gim,
  "",
).trim();

export function TaskMarkdown({ value }: { value: string }) {
  return <div className="task-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} disallowedElements={["img", "a", "input"]} unwrapDisallowed>
    {responseText(value)}
  </Markdown></div>;
}

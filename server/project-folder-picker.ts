import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { projectDirectory } from "./router-project-management.ts";
import { RouterError } from "./router.ts";

const script = `
use framework "AppKit"
use scripting additions
set nativeApp to current application's NSApplication's sharedApplication()
nativeApp's setActivationPolicy:(current application's NSApplicationActivationPolicyAccessory)
nativeApp's activateIgnoringOtherApps:true
try
  set selectedFolder to choose folder with prompt "选择 Agent Autoloop 项目文件夹"
  return POSIX path of selectedFolder
on error failureMessage number failureNumber
  if failureNumber is -128 then return ""
  error failureMessage number failureNumber
end try
`;

async function openMacFolder(signal: AbortSignal): Promise<string | null> {
  const unavailable = "当前环境不支持原生文件夹选择。请手动输入绝对路径。";
  if (process.platform !== "darwin") throw new RouterError(501, unavailable);
  const desktop = await stat("/dev/console").catch(() => null);
  if (!desktop || desktop.uid !== process.getuid?.()) throw new RouterError(503, unavailable);
  if (signal.aborted) throw new RouterError(408, "文件夹选择请求已结束。");

  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-e", script], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16_384, killSignal: "SIGKILL",
    }, (error, stdout) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(new RouterError(408, "文件夹选择请求已结束。"));
      else if (error) reject(new RouterError(503, error.killed
        ? "文件夹选择已超时。请重新打开窗口，或手动输入绝对路径。"
        : "无法打开 macOS 文件夹选择窗口。请手动输入绝对路径。"));
      else resolve(stdout.replace(/\n$/, "") || null);
    });
    const stop = () => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function createProjectFolderPicker(open = openMacFolder) {
  let selecting = false;
  return async (signal: AbortSignal): Promise<string | null> => {
    if (selecting) throw new RouterError(409, "文件夹选择窗口已打开。请先完成或取消选择。");
    selecting = true;
    try {
      const selected = await open(signal);
      if (selected === null) return null;
      const directory = await projectDirectory(selected);
      // The registration form trims its input. A trailing separator preserves whitespace in the last component.
      return directory.trimEnd() === directory ? directory : directory + "/";
    } finally { selecting = false; }
  };
}

export const pickProjectFolder = createProjectFolderPicker();

import { consolePort, services, stopService } from "./macos-services.ts";

async function main() {
  const { web, hub } = services(consolePort());
  const results = await Promise.allSettled([web, hub].map(async (service) => {
    if (await stopService(service)) console.log(service.label + "已关闭。");
    else console.log(service.label + "没有由此启动器管理的运行进程。");
  }));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(result.reason.message);
      process.exitCode = 1;
    }
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

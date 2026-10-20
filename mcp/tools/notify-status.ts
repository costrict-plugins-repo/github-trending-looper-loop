import { globalNotifyConfigPath, maskGlobalNotifyConfig, readGlobalNotifyConfig } from "../../driver/notify-config";

export type NotifyStatusInput = Record<string, never>;

export type NotifyStatusDeps = {
  configFile?: string;
};

export async function looperloopNotifyStatus(_input: NotifyStatusInput = {}, deps: NotifyStatusDeps = {}) {
  const configFile = deps.configFile ?? globalNotifyConfigPath();
  const config = await readGlobalNotifyConfig(configFile);
  return {
    ok: true,
    configPath: configFile,
    config: maskGlobalNotifyConfig(config),
  };
}

import { globalNotifyConfigPath, maskGlobalNotifyConfig, setNotifyChannelEnabled } from "../../driver/notify-config";

export type NotifySetEnabledInput = {
  id: string;
  enabled: boolean;
};

export type NotifySetEnabledDeps = {
  configFile?: string;
};

export async function looperloopNotifySetEnabled(input: NotifySetEnabledInput, deps: NotifySetEnabledDeps = {}) {
  if (!input.id) {
    throw new Error("id is required");
  }
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const configFile = deps.configFile ?? globalNotifyConfigPath();
  const config = await setNotifyChannelEnabled(input.id, input.enabled, configFile);
  return {
    ok: true,
    id: input.id,
    enabled: input.enabled,
    configPath: configFile,
    config: maskGlobalNotifyConfig(config),
  };
}

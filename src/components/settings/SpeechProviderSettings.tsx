import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands, type SpeechProviderSettings as Provider } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { SettingsGroup } from "../ui/SettingsGroup";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

export const SpeechProviderSettings: React.FC<{
  onConfigured?: () => void;
}> = ({ onConfigured }) => {
  const { t } = useTranslation();
  const { settings, refreshSettings, isLoading } = useSettings();
  const [provider, setProvider] = useState<Provider>({
    enabled: false,
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "whisper-1",
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings?.speech_provider) setProvider(settings.speech_provider);
  }, [settings?.speech_provider]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await commands.setSpeechProvider(provider);
      if (result.status === "error") throw new Error(result.error);
      await refreshSettings();
      toast.success(t("settings.speechProvider.saved"));
      if (provider.enabled) onConfigured?.();
    } catch {
      toast.error(t("settings.speechProvider.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup title={t("settings.speechProvider.title")}>
      <div className="p-4 space-y-3 text-start">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={provider.enabled}
            disabled={saving || isLoading}
            onChange={(event) =>
              setProvider({ ...provider, enabled: event.target.checked })
            }
          />
          {t("settings.speechProvider.enabled")}
        </label>
        <p className="text-sm text-text/70">
          {t("settings.speechProvider.description")}
        </p>
        {provider.enabled && (
          <>
            <p className="text-sm text-text/70">
              {t("settings.speechProvider.compatibility")}
            </p>
            {(["base_url", "model", "api_key"] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-sm">
                {t(`settings.speechProvider.${field}`)}
                <Input
                  type={field === "api_key" ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={provider[field]}
                  disabled={saving || isLoading}
                  onChange={(event) =>
                    setProvider({ ...provider, [field]: event.target.value })
                  }
                />
              </label>
            ))}
          </>
        )}
        <Button onClick={() => void save()} disabled={saving || isLoading}>
          {t("settings.speechProvider.save")}
        </Button>
      </div>
    </SettingsGroup>
  );
};

import React from "react";
import { Card } from "../../components/Card";
import { ToolButton } from "../../components/ToolButton";
import { NonDeletedExcalidrawElement } from "../../element/types";
import { AppState, BinaryFiles } from "../../types";
import { useI18n } from "../../i18n";
import { trackEvent } from "../../analytics";
import { getFrame } from "../../utils";
import { ExcalidrawLogo } from "../../components/ExcalidrawLogo";

export const ExportToExcalidrawPlus: React.FC<{
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  onError: (error: Error) => void;
}> = ({ elements, appState, files, onError }) => {
  const { t } = useI18n();
  return (
    <Card color="primary">
      <div className="Card-icon">
        <ExcalidrawLogo
          style={{
            [`--color-logo-icon` as any]: "#fff",
            width: "2.8rem",
            height: "2.8rem",
          }}
        />
      </div>
      <h2>Excalidraw+</h2>
      <div className="Card-details">
        {t("exportDialog.excalidrawplus_description")}
      </div>
      <ToolButton
        className="Card-button"
        type="button"
        title={t("exportDialog.excalidrawplus_button")}
        aria-label={t("exportDialog.excalidrawplus_button")}
        showAriaLabel={true}
        onClick={async () => {
          try {
            trackEvent("export", "eplus", `ui (${getFrame()})`);
            // await exportToExcalidrawPlus(elements, appState, files);
          } catch (error: any) {
            console.error(error);
            if (error.name !== "AbortError") {
              onError(new Error(t("exportDialog.excalidrawplus_exportError")));
            }
          }
        }}
      />
    </Card>
  );
};

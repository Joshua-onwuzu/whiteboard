/* eslint-disable react-hooks/exhaustive-deps */
import polyfill from "../../../polyfill";
import LanguageDetector from "i18next-browser-languagedetector";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "../../../analytics";
import { ErrorDialog } from "../../../components/ErrorDialog";
import { TopErrorBoundary } from "../../../components/TopErrorBoundary";
import * as Y from "yjs";
import {
  APP_NAME,
  EVENT,
  THEME,
  TITLE_TIMEOUT,
  VERSION_TIMEOUT,
} from "../../../constants";
import {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
  Theme,
} from "../../../element/types";
import { useCallbackRefState } from "../../../hooks/useCallbackRefState";
import { newElementWith } from "../../../../src/element/mutateElement";
import { t } from "../../../i18n";
import { Excalidraw, defaultLang } from "../index";
import {
  AppState,
  LibraryItems,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
} from "../../../types";
import {
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  ResolvablePromise,
  resolvablePromise,
  isRunningInIframe,
} from "../../../utils";
import { STORAGE_KEYS, SYNC_BROWSER_TABS_TIMEOUT } from "./app_constants";
import Collab, {
  CollabAPI,
  collabAPIAtom,
  collabDialogShownAtom,
  isCollaboratingAtom,
  isOfflineAtom,
} from "./collab/Collab";
import { isCollaborationLink } from "./data";
import {
  getLibraryItemsFromStorage,
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "./data/localStorage";
import CustomStats from "./CustomStats";
import { restore } from "../../../data/restore";
import { ExportToExcalidrawPlus } from "./components/ExportToExcalidrawPlus";
import { updateStaleImageStatuses } from "./data/FileManager";
import { isInitializedImageElement } from "../../../element/typeChecks";
import { LocalData } from "./data/LocalData";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "../../../data/library";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { AppFooter } from "./components/AppFooter";
import { atom, Provider, SetStateAction, useAtom, useAtomValue } from "jotai";
import { useAtomWithInitialValue } from "../../../jotai";
import { appJotaiStore } from "./app-jotai";

import "./index.scss";
import { ShareableLinkDialog } from "../../../components/ShareableLinkDialog";
import { OverwriteConfirmDialog } from "../../../components/OverwriteConfirm/OverwriteConfirm";
import { IndexeddbPersistence } from "y-indexeddb";
import { ISEAPair } from "gun";
import { Base64 } from "base64-string";
import { ResolutionType } from "../../../utility-types";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

let isSelfEmbedding = false;

if (window.self !== window.top) {
  try {
    const parentUrl = new URL(document.referrer);
    const currentUrl = new URL(window.location.href);
    if (parentUrl.origin === currentUrl.origin) {
      isSelfEmbedding = true;
    }
  } catch (error) {
    // ignore
  }
}

const languageDetector = new LanguageDetector();
languageDetector.init({
  languageUtils: {},
});

const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
  provider: IndexeddbPersistence;
  canvasId: string;
}) => {
  const scene = await Promise.race([
    new Promise((resolve) => {
      opts.provider.on("synced", (data: IndexeddbPersistence) => {
        resolve(data.doc.getMap(opts.canvasId).toJSON());
      });
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve(null), 10000);
    }),
  ]);
  //@ts-ignore
  const data = restore(scene || null, null, null, {
    repairBindings: true,
  });
  if (opts.collabAPI && opts.excalidrawAPI) {
    opts.collabAPI.startCollaboration();
  }
  return {
    elements: data.elements,
    appState: {
      ...data?.appState,
      collaborators: new Map(Object.entries(data?.appState?.collaborators)),
    },
    files: data.files,
    commitToHistory: false,
  };
};
const getWhiteboardKeys = (
  key: string,
): {
  contentKey: ISEAPair;
  fileKey: string;
} => {
  const enc = new Base64();
  const b64 = enc.decode(key);
  const contentKey = JSON.parse(b64)?.seaKeyPair;
  const fileKey = JSON.parse(b64)?.roomKey;
  return {
    contentKey,
    fileKey,
  };
};
const getRoomInfoFromLink = (link: string) => {
  const formatedLink = link.replace("/#", "");
  const url = new URL(formatedLink);

  const urlSearchParams = url.searchParams;
  const rtcKey = urlSearchParams.get("key");
  const rtcId = url.pathname
    .substring(url.pathname.lastIndexOf("/"))
    .replace("/", "");
  if (!rtcKey || !rtcId) {
    throw new Error(
      "rtc id and rtc key must be passed to url before rendering whiteboard",
    );
  }
  const collabParams = urlSearchParams.get("collab");
  const path = url.pathname.substring(1, url.pathname.length);
  const contractAddress = path.substring(0, path.indexOf("/"));
  const { contentKey } = getWhiteboardKeys(rtcKey as string);
  return { rtcId, collabParams, rtcKey: contentKey, contractAddress };
};

const detectedLangCode = languageDetector.detect() || defaultLang.code;
export const appLangCodeAtom = atom(
  Array.isArray(detectedLangCode) ? detectedLangCode[0] : detectedLangCode,
);

const ExcalidrawWrapper = ({
  topRightUI,
  topLeftUI,
}: {
  topRightUI?: (
    isCollaborating: boolean,
    setCollabDialogShown: (update: SetStateAction<boolean>) => void,
    api: ExcalidrawImperativeAPI | null,
  ) => JSX.Element;
  topLeftUI?: () => JSX.Element;
}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [langCode, setLangCode] = useAtom(appLangCodeAtom);
  const isCollabDisabled = isRunningInIframe();
  const {
    rtcId: canvasId,
    rtcKey: canvasDecryptionkey,
    contractAddress,
    collabParams,
  } = getRoomInfoFromLink(window.location.href);
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap(canvasId);
  const provider = new IndexeddbPersistence(canvasId, ydoc);

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();

  const [collabAPI] = useAtom(collabAPIAtom);
  const [, setCollabDialogShown] = useAtom(collabDialogShownAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });

  useHandleLibrary({
    excalidrawAPI,
    getInitialLibraryItems: getLibraryItemsFromStorage,
  });

  useEffect(() => {
    if (
      !excalidrawAPI ||
      (!isCollabDisabled && !collabAPI) ||
      !canvasId ||
      !canvasDecryptionkey
    ) {
      return;
    }
    const loadImages = (
      data: ResolutionType<typeof initializeScene>,
      isInitialLoad = false,
    ) => {
      if (!data) {
        return;
      }
      if (collabAPI?.isCollaborating()) {
        if (data.elements) {
          // collabAPI
          //   .fetchImageFilesFromIPFS({
          //     elements: data.elements,
          //     forceFetchFiles: true,
          //   })
          //   .then(({ loadedFiles, erroredFiles }) => {
          //     excalidrawAPI.addFiles(loadedFiles);
          //     updateStaleImageStatuses({
          //       excalidrawAPI,
          //       erroredFiles,
          //       elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
          //     });
          //   });
        }
      }
      const fileIds =
        data.elements?.reduce((acc, element) => {
          if (isInitializedImageElement(element)) {
            return acc.concat(element.fileId);
          }
          return acc;
        }, [] as FileId[]) || [];

      // if (data.isExternalScene) {
      //   loadFilesFromFirebase(
      //     `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
      //     data.key,
      //     fileIds,
      //   ).then(({ loadedFiles, erroredFiles }) => {
      //     excalidrawAPI.addFiles(loadedFiles);
      //     updateStaleImageStatuses({
      //       excalidrawAPI,
      //       erroredFiles,
      //       elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
      //     });
      //   });
      // }
      if (isInitialLoad) {
        if (fileIds.length) {
          LocalData.fileStorage
            .getFiles(fileIds)
            .then(({ loadedFiles, erroredFiles }) => {
              if (loadedFiles.length) {
                excalidrawAPI.addFiles(loadedFiles);
              }
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
        // on fresh load, clear unused files from IDB (from previous
        // session)
        LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds });
      }
    };
    initializeScene({
      collabAPI,
      excalidrawAPI,
      provider,
      canvasId,
    }).then((data) => {
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data);
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI?.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({
          collabAPI,
          excalidrawAPI,
          provider,
          canvasId,
        }).then((data) => {
          if (data) {
            excalidrawAPI.updateScene({
              ...data,
              ...restore(data, null, null, { repairBindings: true }),
              commitToHistory: true,
            });
          }
        });
      }
    };

    const titleTimeout = setTimeout(
      () => (document.title = APP_NAME),
      TITLE_TIMEOUT,
    );

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          let langCode = languageDetector.detect() || defaultLang.code;
          if (Array.isArray(langCode)) {
            langCode = langCode[0];
          }
          setLangCode(langCode);
          excalidrawAPI.updateScene({
            ...localDataState,
          });
          excalidrawAPI.updateLibrary({
            libraryItems: getLibraryItemsFromStorage(),
          });
          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const visibilityChange = (event: FocusEvent | Event) => {
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
      clearTimeout(titleTimeout);
    };
  }, [isCollabDisabled, collabAPI, excalidrawAPI, setLangCode]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        preventUnload(event);
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    languageDetector.cacheUserLanguage(langCode);
  }, [langCode]);

  const [theme, setTheme] = useState<Theme>(
    () =>
      (localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_THEME,
      ) as Theme | null) ||
      // FIXME migration from old LS scheme. Can be removed later. #5660
      importFromLocalStorage().appState?.theme ||
      THEME.LIGHT,
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, theme);
    // currently only used for body styling during init (see public/index.html),
    // but may change in the future
    document.documentElement.classList.toggle("dark", theme === THEME.DARK);
  }, [theme]);

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI) {
      collabAPI.syncElements(elements, appState);
    }

    setTheme(appState.theme);
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            excalidrawAPI.updateScene({
              elements,
            });
          }
        }
      });
    }
  };

  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const onLibraryChange = async (items: LibraryItems) => {
    if (!items.length) {
      localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY);
      return;
    }
    const serializedItems = JSON.stringify(items);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY, serializedItems);
  };

  const isOffline = useAtomValue(isOfflineAtom);

  // browsers generally prevent infinite self-embedding, there are
  // cases where it still happens, and while we disallow self-embedding
  // by not whitelisting our own origin, this serves as an additional guard
  if (isSelfEmbedding) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
        }}
      >
        <h1>I'm not a pretzel!</h1>
      </div>
    );
  }

  return (
    <div
      style={{ height: "100%" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
      })}
    >
      <Excalidraw
        ref={excalidrawRefCallback}
        onChange={onChange}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              renderCustomUI: (elements, appState, files) => {
                return (
                  <ExportToExcalidrawPlus
                    elements={elements}
                    appState={appState}
                    files={files}
                    onError={(error) => {
                      excalidrawAPI?.updateScene({
                        appState: {
                          errorMessage: error.message,
                        },
                      });
                    }}
                  />
                );
              },
            },
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        onLibraryChange={onLibraryChange}
        autoFocus={true}
        theme={theme}
        renderTopRightUI={(isMobile) => {
          if (isMobile || !collabAPI || isCollabDisabled || !topRightUI) {
            return null;
          }
          return (
            // <LiveCollaborationTrigger
            //   isCollaborating={isCollaborating}
            //   onSelect={() => setCollabDialogShown(true)}
            // />
            topRightUI(isCollaborating, setCollabDialogShown, excalidrawAPI)
          );
        }}
      >
        <AppMainMenu
          setCollabDialogShown={setCollabDialogShown}
          isCollaborating={isCollaborating}
          isCollabEnabled={!isCollabDisabled}
          topLeftUI={topLeftUI}
        />
        <AppWelcomeScreen
          setCollabDialogShown={setCollabDialogShown}
          isCollabEnabled={!isCollabDisabled}
        />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
          {excalidrawAPI && (
            <OverwriteConfirmDialog.Action
              title={t("overwriteConfirm.action.excalidrawPlus.title")}
              actionLabel={t("overwriteConfirm.action.excalidrawPlus.button")}
              onClick={() => null}
            >
              {t("overwriteConfirm.action.excalidrawPlus.description")}
            </OverwriteConfirmDialog.Action>
          )}
        </OverwriteConfirmDialog>
        <AppFooter />
        {isCollaborating && isOffline && (
          <div className="collab-offline-warning">
            {t("alerts.collabOfflineWarning")}
          </div>
        )}
        {latestShareableLink && (
          <ShareableLinkDialog
            link={latestShareableLink}
            onCloseRequest={() => setLatestShareableLink(null)}
            setErrorMessage={setErrorMessage}
          />
        )}
        {excalidrawAPI && !isCollabDisabled && (
          <Collab
            yMap={yMap}
            isNewCollaborating={collabParams === "true"}
            contractAddress={contractAddress}
            decryptionKey={canvasDecryptionkey as ISEAPair}
            canvasId={canvasId}
            excalidrawAPI={excalidrawAPI}
          />
        )}
        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}
      </Excalidraw>
    </div>
  );
};

const ExcalidrawApp = ({
  topRightUI,
  topLeftUI,
}: {
  topLeftUI?: () => JSX.Element;
  topRightUI?: (
    isCollaborating: boolean,
    setCollabDialogShown: (update: SetStateAction<boolean>) => void,
    api: ExcalidrawImperativeAPI | null,
  ) => JSX.Element;
}) => {
  return (
    <TopErrorBoundary>
      <Provider unstable_createStore={() => appJotaiStore}>
        <ExcalidrawWrapper topLeftUI={topLeftUI} topRightUI={topRightUI} />
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;

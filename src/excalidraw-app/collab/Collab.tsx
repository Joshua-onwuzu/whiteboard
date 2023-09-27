import throttle from "lodash.throttle";
import { PureComponent } from "react";
import { AppState, ExcalidrawImperativeAPI } from "../../types";
import { ErrorDialog } from "../../components/ErrorDialog";
import { APP_NAME, ENV, EVENT } from "../../constants";
import { ImportedDataState } from "../../data/types";
import * as Y from "yjs";
import {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
} from "../../element/types";
import {
  getSceneVersion,
  restoreElements,
} from "../../packages/excalidraw/index";
import { Collaborator, Gesture } from "../../types";
import {
  preventUnload,
  resolvablePromise,
  withBatchedUpdates,
} from "../../utils";
import Gun, { ISEAPair } from "gun";
import Sea from "gun/sea";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SCENE_EVENT_TYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getCollabServer,
  getSyncableElements,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import Portal from "./Portal";
import RoomDialog from "./RoomDialog";
import { t } from "../../i18n";
import { UserIdleState } from "../../types";
import { IDLE_THRESHOLD, ACTIVE_THRESHOLD } from "../../constants";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { AbortError } from "../../errors";
import {
  isImageElement,
  isInitializedImageElement,
} from "../../element/typeChecks";
import { newElementWith } from "../../element/mutateElement";
import {
  ReconciledElements,
  reconcileElements as _reconcileElements,
} from "./reconciliation";
import { decryptData } from "../../data/encryption";
import { resetBrowserStateVersions } from "../data/tabSync";
import { LocalData } from "../data/LocalData";
import { atom, useAtom } from "jotai";
import { appJotaiStore } from "../app-jotai";
import { WebrtcProvider } from "y-webrtc";
import { fromUint8Array } from "js-base64";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const collabDialogShownAtom = atom(false);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string;
  username: string;
  activeRoomLink: string;
}

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: (username: string) => void;
}
export const instantiateGun = () => {
  return Gun({
    peers: ["http://localhost:8765/gun"],
  });
};
export const instantiateSEA = () => {
  return Sea;
};

interface PublicProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
  yMap: Y.Map<unknown>;
  canvasId: string;
  decryptionKey: ISEAPair;
  contractAddress: string;
  isNewCollaborating: boolean;
}

type Props = PublicProps & { modalIsShown: boolean };

class Collab extends PureComponent<Props, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: Props["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;
  yMap: Y.Map<unknown>;
  canvasId: string;
  decryptionKey: ISEAPair;
  contractAddress: string;
  isNewCollaborating: boolean;
  webrtcProvider: WebrtcProvider | null;
  searchParams: URLSearchParams;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<string, Collaborator>();

  constructor(props: Props) {
    super(props);
    this.state = {
      errorMessage: "",
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: "",
    };
    this.canvasId = props.canvasId;
    this.decryptionKey = props.decryptionKey;
    this.contractAddress = props.contractAddress;
    this.isNewCollaborating = props.isNewCollaborating;
    this.portal = new Portal(this);
    this.webrtcProvider = null;
    this.searchParams = new URLSearchParams();

    this.fileManager = new FileManager({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
    this.yMap = props.yMap;
  }

  componentDidMount() {
    // window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    // window.addEventListener(EVENT.UNLOAD, this.onUnload);

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
    };
    console.log("AT THIS POINT IT SHOULD SET ATOM");
    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (import.meta.env.MODE === ENV.TEST || import.meta.env.DEV) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    // window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    // window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };
  stopCollaboration = (keepRemoteState = true) => {
    this.saveCanvasStateOnGun();
    resetBrowserStateVersions();
    const link = window.location.href;
    const formatedLink = link.replace("/#", "");
    const url = new URL(formatedLink);
    const urlSearchParams = url.searchParams;
    urlSearchParams.delete("collab");
    window.history.pushState(
      {},
      APP_NAME,
      `${url.origin}/#${url.pathname}${url.search}`,
    );
    this.lastBroadcastedOrReceivedSceneVersion = -1;

    this.setIsCollaborating(false);
    this.setState({
      activeRoomLink: "",
    });
    instantiateGun()
      .user()
      .auth(this.decryptionKey)
      .get(`${this.contractAddress}/${this.canvasId}/mouse`)
      .get(this.webrtcProvider?.awareness.clientID)
      .get(null);

    if (this.webrtcProvider) {
      this.webrtcProvider.disconnect();
      this.webrtcProvider.destroy();
    }
    this.collaborators = new Map();
    this.excalidrawAPI.updateScene({
      collaborators: this.collaborators,
    });
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileHandled(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private getSavedCanvasElementsFromGun = async ({
    decryptionKey,
    contractAddress,
    canvasId,
  }: {
    decryptionKey: ISEAPair;
    contractAddress: string;
    canvasId: string;
  }): Promise<readonly ExcalidrawElement[]> => {
    const elements = await Promise.race([
      new Promise((resolve) => {
        const contentNode = instantiateGun()
          .user()
          .auth(decryptionKey as ISEAPair)
          .get(`${contractAddress}/document/content/${canvasId}`);
        contentNode.on(async (data: string) => {
          const decryptedData: { elements: readonly ExcalidrawElement[] } =
            await Sea.decrypt(data, this.decryptionKey);
          resolve(decryptedData.elements);
          contentNode.off();
        });
      }),
      new Promise((resolve) => setTimeout(() => resolve([]), 2000)),
    ]);
    return elements as readonly ExcalidrawElement[];
  };

  // private listenForCursorUpdate = (
  //   decryptionKey,
  //   contractAddress,
  //   canvasId,
  // ) => {
  //   const node = instantiateGun()
  //     .user()
  //     .auth(decryptionKey as ISEAPair)
  //     .get(`${contractAddress}/document/cursor/${canvasId}`);

  //   node.on((data: any) => {
  //     const { pointer, button, username, selectedElementIds } = data;
  //     const userId = data.userId;

  //     const collaborators = new Map(this.collaborators);
  //     const user = collaborators.get(userId) || {}!;
  //     user.pointer = pointer;
  //     user.button = button;
  //     user.selectedElementIds = selectedElementIds;
  //     user.username = username;
  //     collaborators.set(userId, user);
  //     this.excalidrawAPI.updateScene({
  //       collaborators,
  //     });
  //   });
  // };

  startCollaboration = async () => {
    /**
     * when there is a change in ydoc type - update scene
     *
     */
    console.log(window.location, "<<---");
    this.yMap.observe((event: any) => {
      if (event.transaction.origin !== this) {
        console.log("CHANGE IS DETECTED IN TYPE AND ITS EXTERNAL");
        const el = this.yMap.toJSON()?.elements;
        const canvasReconciledElements = this.reconcileElements(el as any);
        this.excalidrawAPI.updateScene({
          elements: canvasReconciledElements,
          commitToHistory: true,
        });
      }
    });
    if (this.isNewCollaborating) {
      this.activateCollaboration();
    }
  };

  private reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledElements => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();

    remoteElements = restoreElements(remoteElements, null);

    const reconciledElements = _reconcileElements(
      localElements,
      remoteElements,
      appState,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(collaborators: Map<any, any>) {
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };
  public broadcastMouseLocation = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {
    if (this.isCollaborating()) {
      console.log("USER IS COLLABORATING");
      const clientId = this.webrtcProvider?.awareness.clientID;
      const node = instantiateGun()
        .user()
        .auth(this.decryptionKey)
        .get(`${this.contractAddress}/${this.canvasId}/mouse`);
      const data = {
        clientId,
        pointer: payload.pointer,
        button: payload.button || "up",
        selectedElementIds: this.excalidrawAPI.getAppState().selectedElementIds,
        username: this.state.username,
      };
      node.get(clientId).put({ state: JSON.stringify(data) });
    }
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      // payload.pointersMap.size < 2 &&
      //   this.webrtcProvider &&
      this.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  applyChangesOnYdoc = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
  ) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);

      Y.transact(
        this.yMap?.doc as Y.Doc,
        () => {
          console.log("MAKING TRANSACTION ON YDOC DUE TO CHANGE IN CANVAS");
          this.yMap.set("elements", JSON.parse(JSON.stringify(elements)));
          this.yMap.set("appState", JSON.parse(JSON.stringify(appState)));
        },
        this,
      );
    }
  };
  saveCanvasStateOnGun = async () => {
    const node = instantiateGun()
      .user()
      .auth(this.decryptionKey)
      .get(`${this.contractAddress}/whiteboard/${this.canvasId}/mouse`);
    const elements = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    const data = {
      elements,
    };
    const encryptedData = await Sea.encrypt(data, this.decryptionKey);
    node.put(encryptedData);
  };

  activateCollaboration = async () => {
    window.history.pushState(
      {},
      "JOSHUA",
      `${location.origin}${location.hash}&collab=true`,
    );

    console.log("I AM ABOUT TO INSTANTIATE RTC ");
    const provider = new WebrtcProvider(
      this.canvasId,
      this.yMap?.doc as Y.Doc,
      {
        signaling: [
          "wss://fileverse-signaling-server-0529292ff51c.herokuapp.com",
        ],
      },
    );
    this.webrtcProvider = provider;
    provider.awareness.on("update", () => {
      this.setCollaborators(provider.awareness.states);
      this.excalidrawAPI.updateScene({
        collaborators: provider.awareness.states as any,
      });
    });

    const node = instantiateGun()
      .user()
      .auth(this.decryptionKey)
      .get(`${this.contractAddress}/${this.canvasId}/mouse`);
    node
      .map((data: any) =>
        data?.state.clientId !== this.webrtcProvider?.awareness.clientID
          ? data?.state
          : undefined,
      )
      .on((data: any) => {
        console.log(
          "DATA COMING FROM MOUSE NODE",
          data,
          this.webrtcProvider?.awareness.clientID,
        );
        const { pointer, button, username, selectedElementIds, clientId } =
          JSON.parse(data);
        console.log(
          "Hitting this pointer for ",
          data,
          { pointer, button, username, selectedElementIds },
          provider.awareness.clientID === data?.clientId,
        );
        if (clientId === this.webrtcProvider?.awareness.clientID) {
          return;
        }
        const userId = clientId;
        const collaborators = new Map(this.collaborators);
        const user = collaborators.get(userId) || {}!;
        user.pointer = pointer;
        user.button = button;
        user.selectedElementIds = selectedElementIds;
        user.username = username;
        collaborators.set(userId, user);
        console.log("SETTING COLLABORATORS", collaborators);
        this.excalidrawAPI.updateScene({
          collaborators,
        });
      });
    /**
     * if not username create username
     *
     */
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.onUsernameChange(username);
      });
    }
    /**
     *  if no roomID and no roomKey - create an append to url
     *
     */
    /**
     *
     * pick save items from on and reconcile with current scene
     *
     */

    const savedElements = await this.getSavedCanvasElementsFromGun({
      decryptionKey: this.decryptionKey,
      contractAddress: this.contractAddress,
      canvasId: this.canvasId,
    });
    const canvasReconciledElements = this.reconcileElements(savedElements);

    /**
     * Apply the reconciled elements on ydoc
     *
     */
    this.yMap.doc?.transact(() => {
      console.log("TRANSAVTING ON YMAP");
      this.yMap.set(
        "elements",
        JSON.parse(JSON.stringify(canvasReconciledElements)),
      );
    });
    this.initializeIdleDetector();
    this.setState({
      activeRoomLink: window.location.href,
    });
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(canvasReconciledElements),
    );

    /**
     * Whenever there is a update on ydoc save elements to gun
     *
     */
    this.yMap.doc?.on("update", async () => {
      console.log("SAVE UPDATES TO GUN");
      this.saveCanvasStateOnGun();
    });
    /**
     * Listen for cursor updates and update scene
     *
     */
    // this.listenForCursorUpdate(decryptionKey, contractAddress, canvasId);
    // const onIdleStatus = (decryptedData: any) => {
    //   const { userState, socketId, username } = decryptedData.payload;
    //   const collaborators = new Map(this.collaborators);
    //   const user = collaborators.get(socketId) || {}!;
    //   user.userState = userState;
    //   user.username = username;
    //   this.excalidrawAPI.updateScene({
    //     collaborators,
    //   });
    // };

    this.setIsCollaborating(true);
  };

  syncElements = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
  ) => {
    this.applyChangesOnYdoc(elements, appState);
  };

  handleClose = () => {
    appJotaiStore.set(collabDialogShownAtom, false);
  };

  setUsername = (username: string) => {
    this.setState({ username });
  };

  onUsernameChange = (username: string) => {
    this.setUsername(username);
    saveUsernameToLocalStorage(username);
  };

  render() {
    const { username, errorMessage, activeRoomLink } = this.state;

    const { modalIsShown } = this.props;

    return (
      <>
        {modalIsShown && (
          <RoomDialog
            handleClose={this.handleClose}
            activeRoomLink={activeRoomLink}
            username={username}
            onUsernameChange={this.onUsernameChange}
            onRoomCreate={() => this.activateCollaboration()}
            onRoomDestroy={this.stopCollaboration}
            setErrorMessage={(errorMessage) => {
              this.setState({ errorMessage });
            }}
          />
        )}
        {errorMessage && (
          <ErrorDialog onClose={() => this.setState({ errorMessage: "" })}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (import.meta.env.MODE === ENV.TEST || import.meta.env.DEV) {
  window.collab = window.collab || ({} as Window["collab"]);
}

const _Collab: React.FC<PublicProps> = (props) => {
  const [collabDialogShown] = useAtom(collabDialogShownAtom);
  return <Collab {...props} modalIsShown={collabDialogShown} />;
};

export default _Collab;

export type TCollabClass = Collab;

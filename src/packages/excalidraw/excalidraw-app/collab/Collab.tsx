import throttle from "lodash.throttle";
import { PureComponent } from "react";
import { AppState, ExcalidrawImperativeAPI } from "../../../../types";
import { ErrorDialog } from "../../../../components/ErrorDialog";
import { APP_NAME, ENV, EVENT } from "../../../../constants";
import * as Y from "yjs";
import { ExcalidrawElement } from "../../../../element/types";
import {
  getSceneVersion,
  restoreElements,
} from "../../index";
import { Collaborator, Gesture } from "../../../../types";
import Gun, { ISEAPair } from "gun";
import Sea from "gun/sea";
import { CURSOR_SYNC_TIMEOUT } from "../app_constants";
import { SocketUpdateDataSource } from "../data";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import RoomDialog from "./RoomDialog";
import {
  ReconciledElements,
  reconcileElements as _reconcileElements,
} from "./reconciliation";
import { resetBrowserStateVersions } from "../data/tabSync";
import { atom, useAtom } from "jotai";
import { appJotaiStore } from "../app-jotai";
import { WebrtcProvider } from "y-webrtc";

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
    this.webrtcProvider = null;
    this.searchParams = new URLSearchParams();
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
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
    };
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
  private removeCollaborationUrl = () => {
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
  };
  stopCollaboration = (keepRemoteState = true) => {
    this.saveCanvasStateOnGun();
    resetBrowserStateVersions();
    this.removeCollaborationUrl();
    this.lastBroadcastedOrReceivedSceneVersion = -1;

    this.setIsCollaborating(false);
    this.setState({
      activeRoomLink: "",
    });
    if (this.webrtcProvider) {
      this.webrtcProvider.disconnect();
      this.webrtcProvider.destroy();
    }
    this.collaborators = new Map();
    this.excalidrawAPI.updateScene({
      collaborators: this.collaborators,
    });
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
  private observeYMap = () => {
    this.yMap.observe((event: any) => {
      if (event.transaction.origin !== this) {
        const el = this.yMap.toJSON()?.elements;
        const canvasReconciledElements = this.reconcileElements(el as any);
        this.excalidrawAPI.updateScene({
          elements: canvasReconciledElements,
          commitToHistory: true,
        });
      }
    });
  };

  startCollaboration = async () => {
    /**
     * when there is a change in ydoc type - update scene
     *
     */
    this.observeYMap();
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
    }
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
    if (this.isCollaborating() && this.webrtcProvider) {
      const clientId = this.webrtcProvider?.awareness.clientID;
      const data = {
        clientId,
        pointer: payload.pointer,
        button: payload.button || "up",
        selectedElementIds: this.excalidrawAPI.getAppState().selectedElementIds,
        username: this.state.username,
      };
      this.webrtcProvider.awareness.setLocalState(data);
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

  setCollaborationUrl = () => {
    window.history.pushState(
      {},
      "",
      `${location.origin}${location.hash}&collab=true`,
    );
  };

  observeRemoteCollaboratorCanvasState = (provider: WebrtcProvider) => {
    provider.awareness.on("update", () => {
      const x = new Map(provider.awareness.states);
      const state = x.has(provider.awareness.clientID);
      if (state) {
        x.delete(provider.awareness.clientID);
      }
      this.setCollaborators(x);
      this.excalidrawAPI.updateScene({
        collaborators: x as any,
      });
    });
  };

  activateCollaboration = async () => {
    this.setCollaborationUrl();
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
    this.observeRemoteCollaboratorCanvasState(provider);

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
      this.saveCanvasStateOnGun();
    });
    /**
     * Listen for cursor updates and update scene
     *
     */

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

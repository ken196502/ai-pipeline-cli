/**
 * Native Bridge — Node.js Orchestrator ↔ Native Messaging Host ↔ Chrome Extension
 *
 * Communicates with the Python native messaging host via Unix domain socket.
 * Provides high-level methods for querying DOM, getting element positions, etc.
 */
import { createConnection, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

const DEFAULT_SOCKET_PATH = path.resolve('.videogen-nm.sock');

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pageX: number;
  pageY: number;
}

export interface TileInfo {
  index: number;
  /** Card classification: 'image' or 'video'. */
  kind?: 'image' | 'video';
  /** Stable card identity (data-media-id / img src / element id). */
  key?: string | null;
  mediaId: string | null;
  src: string | null;
  rect: ElementRect;
}

export interface TileRectResult {
  found: boolean;
  rect?: ElementRect;
  totalTiles: number;
  kind?: 'image' | 'video';
  key?: string | null;
  /** True when a hit-test inside the card resolved to the same card root. */
  aimOk?: boolean;
  /** Verified clickable point (screen coords, same space as `rect`) when aimOk. */
  aimPoint?: { x: number; y: number };
  hitKind?: string;
  hitKey?: string | null;
  reason?: string;
}

export interface DOMState {
  imageTiles: TileInfo[];
  videoTiles?: TileInfo[];
  videoUrls: string[];
  pendingTiles: number;
  errorTiles: Array<{ text: string; rect: ElementRect }>;
  chatErrors: string[];
  editorReady: boolean;
  agentModeActive: boolean;
  settingsOpen: boolean;
  projects?: Array<{ projectId: string; url: string; title?: string }>;
  lastUpdate: number;
}

export interface NativeBridgeOptions {
  socketPath?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class NativeBridge {
  private socket: Socket | null = null;
  private connected = false;
  private socketPath: string;
  private requestTimeoutMs: number;
  private requestCounter = 0;
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private receiveBuffer = Buffer.alloc(0);
  private lastState: DOMState | null = null;
  private stateListeners: Array<(state: DOMState) => void> = [];
  private apiErrorListeners: Array<(error: { url: string; statusCode: number }) => void> = [];

  constructor(options?: NativeBridgeOptions) {
    this.socketPath = options?.socketPath || DEFAULT_SOCKET_PATH;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
  }

  /**
   * Connect to the Native Messaging Host via Unix socket.
   */
  async connect(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? 10_000;

    // Discover socket path from .info file
    const infoPath = this.socketPath + '.info';
    if (existsSync(infoPath)) {
      try {
        const info = JSON.parse(readFileSync(infoPath, 'utf8'));
        if (info.socket) this.socketPath = info.socket;
      } catch {}
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`NativeBridge: connection timeout after ${timeout}ms to ${this.socketPath}`));
      }, timeout);

      const sock = createConnection(this.socketPath, () => {
        clearTimeout(timer);
        this.socket = sock;
        this.connected = true;
        console.log(pc.green(`[native-bridge] Connected to native host at ${this.socketPath}`));
        resolve();
      });

      sock.on('data', (data) => this.onData(data));
      sock.on('error', (err) => {
        clearTimeout(timer);
        if (!this.connected) {
          reject(new Error(`NativeBridge: connection failed: ${err.message}`));
        } else {
          console.error(pc.red(`[native-bridge] Socket error: ${err.message}`));
          this.connected = false;
        }
      });
      sock.on('close', () => {
        this.connected = false;
        // Reject all pending requests
        for (const [id, req] of this.pendingRequests) {
          clearTimeout(req.timer);
          req.reject(new Error('NativeBridge socket closed'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  /**
   * Wait for socket path to appear and connect (with retries).
   */
  async waitAndConnect(maxWaitMs: number = 30_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const infoPath = this.socketPath + '.info';
      if (existsSync(this.socketPath) || existsSync(infoPath)) {
        try {
          await this.connect(5_000);
          return;
        } catch {
          // Retry
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`NativeBridge: native host socket not found at ${this.socketPath} after ${maxWaitMs}ms`);
  }

  /**
   * Disconnect from the native host.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a request and wait for a response.
   */
  async request<T = any>(msg: Record<string, any>, timeoutMs?: number): Promise<T> {
    if (!this.connected || !this.socket) {
      throw new Error('NativeBridge: not connected');
    }

    const requestId = `req_${++this.requestCounter}_${Date.now()}`;
    const timeout = timeoutMs ?? this.requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`NativeBridge: request timeout after ${timeout}ms for ${msg.type}`));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.sendRaw({ ...msg, requestId });
    });
  }

  /**
   * Send a fire-and-forget message (no response expected).
   */
  send(msg: Record<string, any>): void {
    this.sendRaw(msg);
  }

  /**
   * Register a listener for DOM state updates from the extension.
   */
  onStateUpdate(listener: (state: DOMState) => void): void {
    this.stateListeners.push(listener);
  }

  /**
   * Register a listener for API error events.
   */
  onApiError(listener: (error: { url: string; statusCode: number }) => void): void {
    this.apiErrorListeners.push(listener);
  }

  /**
   * Get the last known DOM state.
   */
  getLastState(): DOMState | null {
    return this.lastState;
  }

  // ═══════════════════════════════════════════════════════════
  // High-level DOM query methods
  // ═══════════════════════════════════════════════════════════

  /**
   * Query current DOM state from the extension's content script.
   */
  async queryDOM(): Promise<DOMState> {
    const response = await this.request({ type: 'query_dom' });
    if (response.state) {
      this.lastState = response.state;
    }
    return response.state;
  }

  /**
   * Get bounding rect of an element by CSS selector.
   */
  async getElementRect(selector: string): Promise<{ found: boolean; rect?: ElementRect }> {
    return await this.request({ type: 'get_element_rect', selector });
  }

  /**
   * Focus an element and return its absolute screen coordinates.
   */
  async focusElement(selector: string): Promise<{ ok: boolean; rect?: ElementRect }> {
    return await this.request({ type: 'focus_element', selector });
  }

  /**
   * Wait for a selector to appear in the DOM.
   */
  async waitForSelector(selector: string, timeoutMs: number = 30_000): Promise<{ found: boolean; rect?: ElementRect }> {
    return await this.request({ type: 'wait_for_selector', selector, timeoutMs }, timeoutMs + 5_000);
  }

  /**
   * Get page URL and basic info.
   */
  async getPageInfo(): Promise<{ url: string; title: string; bodyText: string }> {
    return await this.request({ type: 'get_page_info' });
  }

  /**
   * Get the rect of a classified canvas card.
   *
   * Pass `{ expect: 'image', matchKey }` to target ONE exact image card. The result
   * carries `aimOk` / `hitKind` / `hitKey`: when `aimOk` is false the centre point of
   * the card hits a different card (e.g. a video card) and must NOT be right-clicked.
   */
  async getImageTileRect(
    options?: number | {
      index?: number;
      matchKey?: string | null;
      matchSrc?: string | null;
      expect?: 'image' | 'video';
    }
  ): Promise<TileRectResult> {
    const opts = typeof options === 'number' ? { index: options } : options || {};
    return await this.request({ type: 'get_image_tile_rect', ...opts });
  }

  /**
   * Scroll the active page to the bottom to load dynamic/lazy content.
   */
  async scrollToBottom(options?: {
    stepPx?: number;
    delayMs?: number;
    maxScrolls?: number;
  }): Promise<{ ok: boolean; totalScrolls?: number }> {
    return await this.request({ type: 'scroll_to_bottom', ...options }, 30_000);
  }

  /**
   * Scroll to the bottom of flow.google.com to load all projects and return them.
   */
  async listProjects(options?: {
    stepPx?: number;
    delayMs?: number;
    maxScrolls?: number;
  }): Promise<Array<{ projectId: string; url: string; title?: string }>> {
    const response = await this.request({ type: 'list_projects', ...options }, 45_000);
    return response.ok && Array.isArray(response.projects) ? response.projects : [];
  }

  /**
   * Extract currently displayed projects from DOM without scrolling.
   */
  async getProjects(): Promise<Array<{ projectId: string; url: string; title?: string }>> {
    const response = await this.request({ type: 'get_projects' }, 15_000);
    return response.ok && Array.isArray(response.projects) ? response.projects : [];
  }

  /**
   * Navigate to a URL.
   */
  async navigate(url: string): Promise<{ ok: boolean; tabId?: number }> {
    return await this.request({ type: 'navigate', url });
  }

  /**
   * Get Chrome window position and size.
   */
  async getWindowInfo(): Promise<{
    ok: boolean;
    window?: { left: number; top: number; width: number; height: number; state: string };
  }> {
    return await this.request({ type: 'get_window_info' });
  }

  /**
   * Ping the native host to verify connectivity.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.request({ type: 'ping' }, 5_000);
      return response.pong === true;
    } catch {
      return false;
    }
  }

  /**
   * Capture a screenshot of the active tab.
   */
  async captureScreenshot(): Promise<string | null> {
    const response = await this.request({ type: 'capture_screenshot' });
    return response.ok ? response.dataUrl : null;
  }

  /**
   * Read the REAL Google Flow credit balance via the top-right avatar panel
   * ("Account details" → ".credits-count"). The content script clicks the
   * avatar, polls for the balance element, closes the panel again, and parses
   * the number. Throws when the balance cannot be read — never guesses.
   * See plan-flow-real-credits-limit.md.
   */
  async getFlowCredits(timeoutMs: number = 20_000): Promise<number> {
    const response = await this.request<{ ok: boolean; credits?: number; error?: string }>(
      { type: 'get_flow_credits', timeoutMs: 8_000 },
      timeoutMs
    );
    if (!response?.ok || typeof response.credits !== 'number' || !Number.isFinite(response.credits)) {
      throw new Error(
        `Could not read the Google Flow credit balance via the avatar panel: ${response?.error || 'unknown error'}`
      );
    }
    return response.credits;
  }

  // ═══════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════

  private sendRaw(msg: Record<string, any>): void {
    if (!this.socket) return;
    const encoded = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(encoded.length, 0);
    this.socket.write(Buffer.concat([header, encoded]));
  }

  private onData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (this.receiveBuffer.length < 4 + length) break;

      const msgData = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);

      try {
        const msg = JSON.parse(msgData.toString('utf8'));
        this.handleMessage(msg);
      } catch {
        // Malformed message
      }
    }
  }

  private handleMessage(msg: any): void {
    // Response to a pending request
    if (msg.responseId && this.pendingRequests.has(msg.responseId)) {
      const req = this.pendingRequests.get(msg.responseId)!;
      this.pendingRequests.delete(msg.responseId);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(new Error(msg.error));
      } else {
        req.resolve(msg);
      }
      return;
    }

    // State update from extension
    if (msg.type === 'state_update' && msg.state) {
      this.lastState = msg.state;
      for (const listener of this.stateListeners) {
        try { listener(msg.state); } catch {}
      }
      return;
    }

    // API error from extension
    if (msg.type === 'api_error') {
      for (const listener of this.apiErrorListeners) {
        try { listener(msg); } catch {}
      }
      return;
    }
  }
}

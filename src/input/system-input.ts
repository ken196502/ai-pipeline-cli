/**
 * System-Level Input Controller
 *
 * Provides OS-level mouse/keyboard operations using xdotool (X11).
 * All events are indistinguishable from real hardware input to Chrome.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

/** Random delay between min and max ms */
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generates Bezier curve control points for natural mouse movement.
 * Returns array of intermediate {x, y} points.
 */
function bezierPath(
  x0: number, y0: number,
  x1: number, y1: number,
  steps: number = 20
): Array<{ x: number; y: number }> {
  // Two random control points for a cubic Bezier
  const cx1 = x0 + (x1 - x0) * (0.2 + Math.random() * 0.3) + (Math.random() - 0.5) * 100;
  const cy1 = y0 + (y1 - y0) * (0.1 + Math.random() * 0.3) + (Math.random() - 0.5) * 80;
  const cx2 = x0 + (x1 - x0) * (0.5 + Math.random() * 0.3) + (Math.random() - 0.5) * 60;
  const cy2 = y0 + (y1 - y0) * (0.5 + Math.random() * 0.3) + (Math.random() - 0.5) * 40;

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y1;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

// ═══════════════════════════════════════════════════════════════
// xdotool detection
// ═══════════════════════════════════════════════════════════════

let _xdotoolPath: string | null = null;
let _xdotoolChecked = false;

async function resolveXdotool(): Promise<string> {
  if (_xdotoolChecked && _xdotoolPath) return _xdotoolPath;
  _xdotoolChecked = true;

  const candidates = ['/usr/bin/xdotool', '/usr/local/bin/xdotool'];
  for (const p of candidates) {
    try {
      await execFileAsync(p, ['version']);
      _xdotoolPath = p;
      return p;
    } catch {}
  }

  // Try PATH
  try {
    const { stdout } = await execFileAsync('which', ['xdotool']);
    const resolved = stdout.trim();
    if (resolved) {
      _xdotoolPath = resolved;
      return resolved;
    }
  } catch {}

  throw new Error(
    'xdotool not found. Install it with: sudo apt-get install xdotool\n' +
    'xdotool is required for system-level mouse/keyboard automation.'
  );
}

async function xdotool(...args: string[]): Promise<string> {
  const bin = await resolveXdotool();
  const { stdout } = await execFileAsync(bin, args, { timeout: 10_000 });
  return stdout.trim();
}

// ═══════════════════════════════════════════════════════════════
// Mouse Operations
// ═══════════════════════════════════════════════════════════════

export interface MousePosition {
  x: number;
  y: number;
}

/**
 * Get current mouse position.
 */
export async function getMousePosition(): Promise<MousePosition> {
  const output = await xdotool('getmouselocation', '--shell');
  const xMatch = output.match(/X=(\d+)/);
  const yMatch = output.match(/Y=(\d+)/);
  return {
    x: xMatch ? parseInt(xMatch[1], 10) : 0,
    y: yMatch ? parseInt(yMatch[1], 10) : 0,
  };
}

/**
 * Move mouse to absolute screen coordinates instantly.
 */
export async function mouseMoveTo(x: number, y: number): Promise<void> {
  await xdotool('mousemove', '--sync', String(Math.round(x)), String(Math.round(y)));
}

/**
 * Move mouse to target using a humanized Bezier curve trajectory.
 */
export async function mouseMoveHumanized(
  targetX: number,
  targetY: number,
  options?: { steps?: number; stepDelayMin?: number; stepDelayMax?: number }
): Promise<void> {
  const steps = options?.steps ?? randomDelay(15, 30);
  const delayMin = options?.stepDelayMin ?? 5;
  const delayMax = options?.stepDelayMax ?? 20;

  const current = await getMousePosition();
  const path = bezierPath(current.x, current.y, targetX, targetY, steps);

  for (const pt of path) {
    await xdotool('mousemove', String(pt.x), String(pt.y));
    await sleep(randomDelay(delayMin, delayMax));
  }

  // Ensure exact final position
  await xdotool('mousemove', '--sync', String(Math.round(targetX)), String(Math.round(targetY)));
}

/**
 * System-level left click at coordinates with humanized movement.
 */
export async function systemClick(
  x: number,
  y: number,
  options?: { humanize?: boolean; preClickDelay?: number }
): Promise<void> {
  const humanize = options?.humanize !== false;

  if (humanize) {
    await mouseMoveHumanized(x, y);
    await sleep(options?.preClickDelay ?? randomDelay(50, 200));
  } else {
    await mouseMoveTo(x, y);
    await sleep(50);
  }

  await xdotool('click', '1'); // Left button
}

/**
 * System-level right click at coordinates with humanized movement.
 */
export async function systemRightClick(
  x: number,
  y: number,
  options?: { humanize?: boolean; preClickDelay?: number }
): Promise<void> {
  const humanize = options?.humanize !== false;

  if (humanize) {
    await mouseMoveHumanized(x, y);
    await sleep(options?.preClickDelay ?? randomDelay(50, 200));
  } else {
    await mouseMoveTo(x, y);
    await sleep(50);
  }

  await xdotool('click', '3'); // Right button
}

/**
 * System-level double click at coordinates.
 */
export async function systemDoubleClick(
  x: number,
  y: number,
  options?: { humanize?: boolean }
): Promise<void> {
  const humanize = options?.humanize !== false;

  if (humanize) {
    await mouseMoveHumanized(x, y);
    await sleep(randomDelay(50, 150));
  } else {
    await mouseMoveTo(x, y);
    await sleep(50);
  }

  await xdotool('click', '--repeat', '2', '--delay', String(randomDelay(30, 80)), '1');
}

/**
 * System-level mouse scroll.
 */
export async function systemScroll(
  x: number,
  y: number,
  delta: number, // positive = down, negative = up
  options?: { humanize?: boolean }
): Promise<void> {
  if (options?.humanize !== false) {
    await mouseMoveHumanized(x, y);
  } else {
    await mouseMoveTo(x, y);
  }
  await sleep(randomDelay(30, 100));

  const button = delta > 0 ? '5' : '4'; // 5=scroll down, 4=scroll up
  const clicks = Math.abs(Math.round(delta));
  for (let i = 0; i < clicks; i++) {
    await xdotool('click', button);
    await sleep(randomDelay(20, 60));
  }
}

// ═══════════════════════════════════════════════════════════════
// Keyboard Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Type text character by character with humanized delays.
 */
export async function systemType(
  text: string,
  options?: { delayMin?: number; delayMax?: number; typoRate?: number }
): Promise<void> {
  const delayMin = options?.delayMin ?? 30;
  const delayMax = options?.delayMax ?? 120;
  const typoRate = options?.typoRate ?? 0; // disabled by default for prompts

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Occasional typo simulation
    if (typoRate > 0 && Math.random() < typoRate) {
      const typoChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await xdotool('type', '--clearmodifiers', '--delay', '0', typoChar);
      await sleep(randomDelay(100, 300));
      await xdotool('key', 'BackSpace');
      await sleep(randomDelay(50, 150));
    }

    // Handle special characters that xdotool 'type' might misinterpret
    if (char === '\n' || char === '\r') {
      await xdotool('key', 'Return');
    } else if (char === '\t') {
      await xdotool('key', 'Tab');
    } else {
      await xdotool('type', '--clearmodifiers', '--delay', '0', char);
    }

    await sleep(randomDelay(delayMin, delayMax));
  }
}

/**
 * Press a key combination (e.g., 'ctrl+a', 'ctrl+v', 'Return', 'Escape').
 * xdotool key names: https://cgit.freedesktop.org/xdotool/tree/xdotool.pod
 */
export async function systemKeyCombo(...keys: string[]): Promise<void> {
  // xdotool uses '+' separator for combos: 'ctrl+a'
  const combo = keys.join('+');
  await xdotool('key', '--clearmodifiers', combo);
}

/**
 * Press and release a single key.
 */
export async function systemKeyPress(key: string): Promise<void> {
  await xdotool('key', '--clearmodifiers', key);
}

/**
 * Select all text in the focused input (Ctrl+A).
 */
export async function systemSelectAll(): Promise<void> {
  await systemKeyCombo('ctrl', 'a');
}

/**
 * Delete selected text (Backspace).
 */
export async function systemDelete(): Promise<void> {
  await systemKeyPress('BackSpace');
}

/**
 * Paste from clipboard (Ctrl+V).
 */
export async function systemPaste(): Promise<void> {
  await systemKeyCombo('ctrl', 'v');
}

/**
 * Copy to clipboard (Ctrl+C).
 */
export async function systemCopy(): Promise<void> {
  await systemKeyCombo('ctrl', 'c');
}

/**
 * Press Enter.
 */
export async function systemEnter(): Promise<void> {
  await systemKeyPress('Return');
}

/**
 * Press Escape.
 */
export async function systemEscape(): Promise<void> {
  await systemKeyPress('Escape');
}

// ═══════════════════════════════════════════════════════════════
// Window Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Get the active window ID.
 */
export async function getActiveWindowId(): Promise<string> {
  return await xdotool('getactivewindow');
}

/**
 * Focus a window by its window ID.
 */
export async function focusWindow(windowId: string): Promise<void> {
  await xdotool('windowactivate', '--sync', windowId);
}

/**
 * Search for a window by name/class and return its window ID.
 */
export async function findWindow(searchTerm: string): Promise<string | null> {
  try {
    const output = await xdotool('search', '--name', searchTerm);
    const ids = output.split('\n').filter(Boolean);
    return ids[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get window geometry (position and size).
 */
export async function getWindowGeometry(windowId: string): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const output = await xdotool('getwindowgeometry', '--shell', windowId);
  const xMatch = output.match(/X=(\d+)/);
  const yMatch = output.match(/Y=(\d+)/);
  const wMatch = output.match(/WIDTH=(\d+)/);
  const hMatch = output.match(/HEIGHT=(\d+)/);
  return {
    x: xMatch ? parseInt(xMatch[1], 10) : 0,
    y: yMatch ? parseInt(yMatch[1], 10) : 0,
    width: wMatch ? parseInt(wMatch[1], 10) : 0,
    height: hMatch ? parseInt(hMatch[1], 10) : 0,
  };
}

/**
 * Read clipboard text content (via xsel or xclip). Returns null when no tool is
 * available — used to VERIFY clipboard writes before pasting.
 */
export async function readClipboard(): Promise<string | null> {
  const tryTool = async (cmd: string, args: string[]): Promise<string | null> => {
    try {
      const { execFile } = await import('node:child_process');
      return await new Promise<string>((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        );
      });
    } catch {
      return null;
    }
  };

  const viaXsel = await tryTool('xsel', ['--clipboard', '--output']);
  if (viaXsel !== null) return viaXsel;
  return await tryTool('xclip', ['-selection', 'clipboard', '-o']);
}

/**
 * Set the system clipboard and VERIFY the write by reading it back.
 *
 * Verification is mandatory: `navigator.clipboard.writeText()` and
 * `document.execCommand('copy')` both silently no-op in this browser build, which
 * made Ctrl+V paste stale clipboard content from earlier runs.
 */
export async function setClipboardVerified(text: string): Promise<void> {
  await setClipboard(text);
  const seen = await readClipboard();
  if (seen !== text) {
    throw new Error(
      `Clipboard write could not be verified (holds ${seen === null ? 'unknown' : seen.length} char(s), expected ${text.length})`
    );
  }
}

/**
 * Set clipboard text content (via xclip or xsel).
 */
export async function setClipboard(text: string): Promise<void> {
  try {
    const { execFile: ef } = await import('node:child_process');
    const child = ef('xclip', ['-selection', 'clipboard']);
    child.stdin?.write(text);
    child.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`))));
      child.on('error', reject);
    });
  } catch {
    // Fallback to xsel
    try {
      const child = execFile('xsel', ['--clipboard', '--input']);
      child.stdin?.write(text);
      child.stdin?.end();
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`xsel exited ${code}`))));
        child.on('error', reject);
      });
    } catch {
      throw new Error('Neither xclip nor xsel available for clipboard operations');
    }
  }
}

/**
 * Put an IMAGE file on the system clipboard (image/png target) so it can be pasted
 * into a prompt box as an attachment / starting frame.
 *
 * xclip is required: xsel only handles text selections and cannot serve image
 * targets. The write is verified by reading the image target back.
 */
export async function setClipboardImage(filePath: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(filePath);
  if (data.length === 0) {
    throw new Error(`Cannot copy an empty image to the clipboard: ${filePath}`);
  }

  try {
    const { execFile: ef } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const child = ef('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i']);
      child.stdin?.write(data);
      child.stdin?.end();
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`))));
      child.on('error', reject);
    });
  } catch (err: any) {
    throw new Error(
      `Cannot put an image on the clipboard (xclip with an image/png target is required, xsel is text-only): ${err?.message || err}`
    );
  }

  const seen = await readClipboardImage();
  if (!seen || seen.length === 0) {
    throw new Error('Clipboard image write could not be verified (image/png target reads back empty)');
  }
}

/**
 * Read the clipboard image/png target (null when unavailable).
 */
export async function readClipboardImage(): Promise<Buffer | null> {
  try {
    const { execFile: ef } = await import('node:child_process');
    return await new Promise<Buffer | null>((resolve) => {
      const child = ef(
        'xclip',
        ['-selection', 'clipboard', '-t', 'image/png', '-o'],
        { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => resolve(err ? null : (stdout as unknown as Buffer))
      );
      child.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

/**
 * Type text efficiently: set clipboard + Ctrl+V paste (for long text).
 * Falls back to character-by-character typing if clipboard tools unavailable.
 */
export async function systemTypeViaPaste(text: string): Promise<void> {
  try {
    await setClipboard(text);
    await sleep(50);
    await systemPaste();
  } catch {
    await systemType(text);
  }
}

// ═══════════════════════════════════════════════════════════════
// Compound Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Clear the currently focused input field and type new text.
 */
export async function systemClearAndType(
  text: string,
  options?: { usePaste?: boolean }
): Promise<void> {
  await systemSelectAll();
  await sleep(randomDelay(30, 80));
  await systemDelete();
  await sleep(randomDelay(50, 150));

  if (options?.usePaste) {
    await systemTypeViaPaste(text);
  } else {
    await systemType(text);
  }
}

/**
 * Check if xdotool is available on this system.
 */
export async function isXdotoolAvailable(): Promise<boolean> {
  try {
    await resolveXdotool();
    return true;
  } catch {
    return false;
  }
}

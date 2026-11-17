import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type ElementHandle,
  type Request,
  type Response,
  type Frame,
} from 'playwright';
import { z } from 'zod';
import {
  browserActionSchema,
  browserObservationSchema,
  browserPlanSchema,
  browserUrlSchema,
  type BrowserAction,
  type BrowserObservation,
  type BrowserRuntimePort,
  type BrowserRuntimeResult,
} from '../../contracts/src/agent-browser.js';
import type { BrowserProxyControlPort } from '../../agent-browser-proxy/src/proxy.js';

interface Session {
  context: BrowserContext;
  page: Page;
  control: 'agent' | 'human';
  privateState: boolean;
  documentId: string;
  observation: BrowserObservation | null;
  handles: Map<string, ElementHandle<Node>>;
  secretValues: Set<string>;
  effectOrigins: Set<string>;
  effectDeadline: number;
  networkWarnings: Set<string>;
  busy: boolean;
  expiresAt: number;
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const runtimeError = (code: string): Error => new Error(code);

/** No script/CDP/cookie/storage/host-file operations are exposed through this runtime. */
export class PlaywrightBrowserRuntime implements BrowserRuntimePort {
  private browser: Browser | undefined;
  private sessions = new Map<string, Session>();
  private results = new Map<
    string,
    { sessionId: string; result: BrowserRuntimeResult; expiresAt: number }
  >();
  constructor(
    readonly options: {
      proxy: BrowserProxyControlPort;
      journalDirectory: string;
      executablePath?: string;
      headless?: boolean;
      chromiumSandbox?: boolean;
      allowedWebSocketOrigins?: readonly string[];
    },
  ) {}
  private async launched() {
    if (!this.browser)
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        chromiumSandbox: this.options.chromiumSandbox ?? true,
        ...(this.options.executablePath
          ? { executablePath: this.options.executablePath }
          : {}),
        args: [
          '--proxy-bypass-list=<-loopback>',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
        ],
      });
    return this.browser;
  }
  private session(id: string, human = false) {
    const session = this.sessions.get(z.uuid().parse(id));
    if (!session || session.expiresAt < Date.now() || session.page.isClosed())
      throw runtimeError('BROWSER_SESSION_CLOSED');
    if (session.control !== (human ? 'human' : 'agent'))
      throw runtimeError('BROWSER_CONTROL_CONFLICT');
    session.expiresAt = Date.now() + 30 * 60_000;
    return session;
  }
  async open(id: string) {
    z.uuid().parse(id);
    if (this.sessions.has(id)) return;
    if (this.sessions.size >= 6)
      throw runtimeError('BROWSER_CAPACITY_EXCEEDED');
    await mkdir(join(this.options.journalDirectory, 'sessions'), {
      recursive: true,
    });
    try {
      await writeFile(
        join(this.options.journalDirectory, 'sessions', `${id}.json`),
        JSON.stringify({ id, createdAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      throw runtimeError('BROWSER_SESSION_EXPIRED');
    }
    const proxy = await this.options.proxy.register(id);
    const context = await (
      await this.launched()
    ).newContext({
      viewport: { width: 1120, height: 760 },
      proxy,
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    const session: Session = {
      context,
      page,
      control: 'agent',
      privateState: false,
      documentId: randomUUID(),
      observation: null,
      handles: new Map(),
      secretValues: new Set(),
      effectOrigins: new Set(),
      effectDeadline: 0,
      networkWarnings: new Set(),
      busy: false,
      expiresAt: Date.now() + 30 * 60_000,
    };
    this.sessions.set(id, session);
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => undefined);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        session.documentId = randomUUID();
        session.observation = null;
      }
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => undefined);
    });
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url());
      if (
        url.protocol !== 'wss:' ||
        !this.options.allowedWebSocketOrigins?.includes(url.origin)
      ) {
        session.networkWarnings.add(
          'WebSocket未获精确origin配置，已阻断；依赖它的页面功能可能不可用。',
        );
        socket.close();
        return;
      }
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const origin = new URL(url.href.replace(/^wss:/, 'https:')).origin;
        if (session.control === 'human' || session.effectOrigins.has(origin))
          server.send(message);
        else
          session.networkWarnings.add(
            'WebSocket客户端消息在批准动作窗口外，已阻断；未伪称提交成功。',
          );
      });
      server.onMessage((message) => socket.send(message));
    });
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        browserUrlSchema.parse(url.href);
        if (
          !['GET', 'HEAD'].includes(request.method()) &&
          (!session.effectOrigins.has(url.origin) ||
            Date.now() >= session.effectDeadline)
        ) {
          session.networkWarnings.add(
            '页面提交在当前动作的精确origin或有限窗口外，已阻断。',
          );
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }
  private async capture(session: Session): Promise<BrowserObservation> {
    for (const handle of session.handles.values())
      await handle.dispose().catch(() => undefined);
    session.handles.clear();
    const page = session.page;
    const rawText = await page
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '');
    for (const secret of session.secretValues)
      for (const value of [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
      ])
        if (value.length >= 3 && rawText.includes(value))
          throw runtimeError('BROWSER_SECRET_VISIBLE');
    const handles = await page
      .locator(
        'a,button,input,textarea,select,[role="button"],[contenteditable="true"]',
      )
      .elementHandles();
    const elements: BrowserObservation['elements'] = [];
    for (const handle of handles) {
      if (elements.length >= 120 || !(await handle.isVisible())) {
        await handle.dispose();
        continue;
      }
      const info = await handle.evaluate((element) => {
        if (!(element instanceof Element))
          throw new Error('BROWSER_TARGET_CHANGED');
        const tag = element.tagName.toLowerCase();
        const inputType = element.getAttribute('type') ?? '';
        const name = element.getAttribute('name') ?? '';
        const sensitive =
          inputType === 'password' ||
          /password|passwd|token|secret|api.?key|cookie|authorization/i.test(
            name + ' ' + element.getAttribute('autocomplete'),
          );
        return {
          tag,
          role:
            element.getAttribute('role') ??
            (tag === 'a' ? 'link' : tag === 'input' ? 'textbox' : tag),
          label: (
            element.getAttribute('aria-label') ??
            element.getAttribute('placeholder') ??
            element.textContent ??
            ''
          )
            .trim()
            .slice(0, 200),
          inputType,
          sensitive,
        };
      });
      const id = `e${elements.length + 1}`;
      session.handles.set(id, handle);
      elements.push({ id, ...info });
    }
    // Values, editable regions, canvas and video may contain credentials that are absent from text.
    const screenshot = await page.screenshot({
      type: 'png',
      timeout: 10_000,
      animations: 'disabled',
      mask: [page.locator('input,textarea,[contenteditable],canvas,video')],
      maskColor: '#737373',
    });
    if (screenshot.byteLength > 4 * 1024 * 1024)
      throw runtimeError('BROWSER_SCREENSHOT_TOO_LARGE');
    const visible = {
      url: page.url(),
      documentId: session.documentId,
      title: (await page.title()).slice(0, 500),
      text: rawText.slice(0, 30_000),
      truncated: rawText.length > 30_000,
      elements,
      privateState: session.privateState,
      networkWarnings: [...session.networkWarnings].slice(0, 20),
    };
    const observation = browserObservationSchema.parse({
      ...visible,
      id: randomUUID(),
      hash: hash(JSON.stringify(visible)),
      screenshotBase64: screenshot.toString('base64'),
      capturedAt: new Date().toISOString(),
      untrustedPageData: true,
    });
    session.observation = observation;
    return observation;
  }
  async observe(id: string, human = false) {
    const session = this.session(id, human);
    if (session.busy) throw runtimeError('BROWSER_BUSY');
    session.busy = true;
    try {
      return await this.capture(session);
    } finally {
      session.busy = false;
    }
  }
  private async once(
    id: string,
    operationId: string,
    human: boolean,
    work: (session: Session, done: () => void) => Promise<void>,
  ): Promise<BrowserRuntimeResult> {
    z.uuid().parse(operationId);
    const session = this.session(id, human);
    if (session.busy) throw runtimeError('BROWSER_BUSY');
    session.busy = true;
    const previous = await this.status(id, operationId).catch((error) => {
      session.busy = false;
      throw error;
    });
    if (previous) {
      session.busy = false;
      return previous;
    }
    await mkdir(join(this.options.journalDirectory, 'operations'), {
      recursive: true,
    }).catch((error) => {
      session.busy = false;
      throw error;
    });
    try {
      await writeFile(
        join(
          this.options.journalDirectory,
          'operations',
          `${operationId}.json`,
        ),
        JSON.stringify({
          sessionId: id,
          operationId,
          dispatchedAt: new Date().toISOString(),
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      session.busy = false;
      return {
        operationId,
        state: 'unknown',
        completedActions: 0,
        errorCode: 'BROWSER_ORIGINAL_RESULT_UNKNOWN',
        observation: null,
      };
    }
    session.busy = true;
    let completedActions = 0,
      started = false;
    try {
      started = true;
      await work(session, () => {
        completedActions++;
      });
      const observation =
        session.control === 'human' ? null : await this.capture(session);
      const result: BrowserRuntimeResult = {
        operationId,
        state: 'completed',
        completedActions,
        errorCode: null,
        observation,
      };
      if (this.results.size >= 16) {
        const oldest = this.results.keys().next().value;
        if (oldest) this.results.delete(oldest);
      }
      this.results.set(operationId, {
        sessionId: id,
        result,
        expiresAt: Date.now() + 120_000,
      });
      return result;
    } catch (error: unknown) {
      const safeCode =
        error instanceof Error &&
        /^BROWSER_[A-Z0-9_]{1,70}$/.test(error.message)
          ? error.message
          : 'BROWSER_ACTION_RESULT_UNKNOWN';
      const result: BrowserRuntimeResult = {
        operationId,
        state:
          started &&
          !/^BROWSER_NAVIGATION_HTTP_[45][0-9]{2}$/.test(safeCode) &&
          ![
            'BROWSER_PAGE_CHANGED',
            'BROWSER_TARGET_CHANGED',
            'BROWSER_MANUAL_SECRET_REQUIRED',
          ].includes(safeCode)
            ? 'unknown'
            : 'failed',
        completedActions,
        errorCode: safeCode,
        observation: null,
      };
      if (this.results.size >= 16) {
        const oldest = this.results.keys().next().value;
        if (oldest) this.results.delete(oldest);
      }
      this.results.set(operationId, {
        sessionId: id,
        result,
        expiresAt: Date.now() + 120_000,
      });
      return result;
    } finally {
      session.busy = false;
      session.effectOrigins.clear();
      session.effectDeadline = 0;
    }
  }
  async navigate(id: string, operationId: string, input: string) {
    const url = browserUrlSchema.parse(input);
    if (this.session(id).privateState)
      throw runtimeError('BROWSER_CONFIRMATION_REQUIRED');
    return this.once(id, operationId, false, async (session, done) => {
      const response = await session.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      if (response && response.status() >= 400)
        throw runtimeError(`BROWSER_NAVIGATION_HTTP_${response.status()}`);
      done();
    });
  }
  async control(id: string, operationId: string, mode: 'agent' | 'human') {
    z.uuid().parse(operationId);
    const session = this.sessions.get(z.uuid().parse(id));
    if (!session || session.busy)
      throw runtimeError('BROWSER_CONTROL_CONFLICT');
    session.control = mode;
    if (mode === 'human') {
      session.privateState = true;
      session.observation = null;
    } else {
      await this.capture(session);
    }
  }
  private async action(
    session: Session,
    action: BrowserAction,
    secret: boolean,
  ) {
    if (action.kind === 'navigate') {
      await this.actionWindow(session, action.url, async () => {
        const response = await session.page.goto(action.url, {
          waitUntil: 'domcontentloaded',
          timeout: 5000,
        });
        if (response && response.status() >= 400)
          throw runtimeError(`BROWSER_NAVIGATION_HTTP_${response.status()}`);
      });
      return;
    }
    if (session.page.url() !== action.atUrl)
      throw runtimeError('BROWSER_PAGE_CHANGED');
    const handle = session.handles.get(action.targetId);
    if (!handle || !(await handle.isVisible()))
      throw runtimeError('BROWSER_TARGET_CHANGED');
    const sensitive = await handle.evaluate(
      (element) =>
        element instanceof Element &&
        (element.getAttribute('type') === 'password' ||
          /password|passwd|token|secret|api.?key|cookie/i.test(
            element.getAttribute('name') ?? '',
          )),
    );
    if (sensitive && !secret && action.kind === 'fill')
      throw runtimeError('BROWSER_MANUAL_SECRET_REQUIRED');
    await this.actionWindow(session, action.atUrl, async () => {
      if (action.kind === 'fill') {
        if (secret) session.secretValues.add(action.value);
        await handle.fill(action.value, { timeout: 5000 });
      } else if (action.kind === 'select')
        await handle.selectOption(action.value, { timeout: 5000 });
      else if (action.kind === 'press')
        await handle.press(action.key, { timeout: 5000 });
      else await handle.click({ timeout: 5000, noWaitAfter: false });
    });
  }
  private async actionWindow(
    session: Session,
    atUrl: string,
    work: () => Promise<void>,
  ) {
    const page = session.page;
    const deadline = Date.now() + 5000;
    const pending = new Set<Request>();
    let lastActivity = Date.now();
    let failure: string | null = null;
    let navigated = false;
    let writeRequested = false;
    const mainNavigation = (request: Request) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const requested = (request: Request) => {
      if (!['GET', 'HEAD'].includes(request.method())) writeRequested = true;
      if (
        mainNavigation(request) ||
        !['GET', 'HEAD'].includes(request.method()) ||
        ['fetch', 'xhr'].includes(request.resourceType())
      ) {
        pending.add(request);
        lastActivity = Date.now();
      }
    };
    const finished = (request: Request) => {
      if (pending.delete(request)) lastActivity = Date.now();
    };
    const failed = (request: Request) => {
      if (pending.has(request)) failure = 'BROWSER_ACTION_NETWORK_FAILED';
      finished(request);
    };
    const responded = (response: Response) => {
      if (mainNavigation(response.request()) && response.status() >= 400)
        failure = `BROWSER_NAVIGATION_HTTP_${response.status()}`;
    };
    const frameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      navigated = true;
      lastActivity = Date.now();
      if (!browserUrlSchema.safeParse(frame.url()).success)
        failure = 'BROWSER_NAVIGATION_FAILED';
    };
    page.on('request', requested);
    page.on('requestfinished', finished);
    page.on('requestfailed', failed);
    page.on('response', responded);
    page.on('framenavigated', frameNavigated);
    session.effectOrigins.add(new URL(atUrl).origin);
    session.effectDeadline = deadline;
    try {
      await work();
      lastActivity = Date.now();
      while (Date.now() < deadline) {
        if (failure) throw runtimeError(failure);
        if (pending.size === 0 && Date.now() - lastActivity >= 250) {
          if (navigated)
            await page.waitForLoadState('domcontentloaded', {
              timeout: Math.max(1, deadline - Date.now()),
            });
          if (failure) throw runtimeError(failure);
          if (Date.now() >= deadline)
            throw runtimeError('BROWSER_ACTION_SETTLE_TIMEOUT');
          return;
        }
        await new Promise<void>((done) => setTimeout(done, 25));
      }
      throw runtimeError('BROWSER_ACTION_SETTLE_TIMEOUT');
    } catch (error: unknown) {
      // An HTTP error after a write cannot establish that no effect occurred.
      if (
        writeRequested &&
        error instanceof Error &&
        /^BROWSER_NAVIGATION_HTTP_[45][0-9]{2}$/.test(error.message)
      )
        throw runtimeError(
          error.message.replace('BROWSER_', 'BROWSER_ACTION_'),
        );
      throw error;
    } finally {
      session.effectOrigins.clear();
      session.effectDeadline = 0;
      page.off('request', requested);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
      page.off('response', responded);
      page.off('framenavigated', frameNavigated);
    }
  }
  async plan(
    id: string,
    operationId: string,
    raw: z.infer<typeof browserPlanSchema>,
  ) {
    const plan = browserPlanSchema.parse(raw);
    return this.once(id, operationId, false, async (current, done) => {
      const original = current.observation;
      if (!original || original.hash !== plan.observationHash)
        throw runtimeError('BROWSER_PAGE_CHANGED');
      if ((await this.capture(current)).hash !== plan.observationHash)
        throw runtimeError('BROWSER_PAGE_CHANGED');
      for (const action of plan.actions) {
        await this.action(current, action, false);
        done();
      }
    });
  }
  async humanAction(
    id: string,
    operationId: string,
    raw: BrowserAction,
    secret: boolean,
  ) {
    const action = browserActionSchema.parse(raw);
    return this.once(id, operationId, true, async (session, done) => {
      await this.action(session, action, secret);
      done();
    });
  }
  async status(
    id: string,
    operationId: string,
  ): Promise<BrowserRuntimeResult | null> {
    z.uuid().parse(id);
    z.uuid().parse(operationId);
    const cached = this.results.get(operationId);
    if (cached && cached.sessionId !== id)
      throw runtimeError('BROWSER_OPERATION_NOT_FOUND');
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.results.delete(operationId);
    try {
      const saved = z
        .strictObject({
          sessionId: z.uuid(),
          operationId: z.uuid(),
          dispatchedAt: z.iso.datetime(),
        })
        .parse(
          JSON.parse(
            await readFile(
              join(
                this.options.journalDirectory,
                'operations',
                `${operationId}.json`,
              ),
              'utf8',
            ),
          ),
        );
      if (saved.sessionId !== id)
        throw runtimeError('BROWSER_OPERATION_NOT_FOUND');
      return {
        operationId,
        state: 'unknown',
        completedActions: 0,
        errorCode: 'BROWSER_ORIGINAL_RESULT_UNKNOWN',
        observation: null,
      };
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    }
  }
  async close(id: string) {
    const session = this.sessions.get(z.uuid().parse(id));
    if (session) {
      await session.context.close();
      session.secretValues.clear();
      session.handles.clear();
      session.observation = null;
      this.sessions.delete(id);
    }
    for (const saved of this.results.values())
      if (saved.sessionId === id) saved.result.observation = null;
    await this.options.proxy.remove(id);
  }
  async shutdown() {
    for (const id of this.sessions.keys()) await this.close(id);
    await this.browser?.close();
    this.results.clear();
  }
}

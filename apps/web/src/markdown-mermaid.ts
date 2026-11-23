import diagramLibrary from '@mermaid-js/tiny/dist/mermaid.tiny.js?url';
import diagramRuntime from './markdown-mermaid-frame?worker&url';

export class MarkdownDiagramRenderer {
  private readonly frame = document.createElement('iframe');
  private readonly channel = new MessageChannel();
  private readonly pending = new Map<number, (svg: string | null) => void>();
  private nextId = 0;
  private readonly ready: Promise<boolean>;

  constructor() {
    const library = new URL(diagramLibrary, window.location.href).href;
    const runtime = new URL(diagramRuntime, window.location.href).href;
    const policy = [
      "default-src 'none'",
      `script-src ${library} ${runtime}`,
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    this.frame.className = 'markdown-diagram-render-frame';
    this.frame.sandbox.add('allow-scripts');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    this.frame.title = '流程图渲染';
    this.frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><main></main><script src="${library}"></script><script src="${runtime}"></script>`;

    this.ready = new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(false), 6000);
      this.channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === 'ready') {
          window.clearTimeout(timer);
          resolve(true);
        }
        const result = event.data;
        if (
          !result ||
          typeof result !== 'object' ||
          !('id' in result) ||
          typeof result.id !== 'number' ||
          !('svg' in result) ||
          (result.svg !== null && typeof result.svg !== 'string')
        )
          return;
        const request = this.pending.get(result.id);
        this.pending.delete(result.id);
        request?.(result.svg);
      };
    });
    this.frame.addEventListener(
      'load',
      () => {
        this.frame.contentWindow?.postMessage('markdown-diagram-preview', '*', [
          this.channel.port2,
        ]);
      },
      { once: true },
    );
    document.body.append(this.frame);
  }

  async render(source: string, dark: boolean): Promise<string | null> {
    if (!(await this.ready) || !this.frame.isConnected) return null;
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 10000);
      this.pending.set(id, (svg) => {
        window.clearTimeout(timer);
        resolve(svg);
      });
      this.channel.port1.postMessage({ id, source, dark });
    });
  }

  close() {
    this.frame.remove();
    this.channel.port1.close();
    this.channel.port2.close();
    for (const request of this.pending.values()) request(null);
    this.pending.clear();
  }
}

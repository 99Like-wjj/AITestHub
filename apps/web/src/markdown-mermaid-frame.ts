interface DiagramApi {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: 'strict';
    htmlLabels: boolean;
    suppressErrorRendering: boolean;
    theme: 'default' | 'dark';
    secure: string[];
  }): void;
  render(
    id: string,
    source: string,
    container: HTMLElement,
  ): Promise<{ svg: string }>;
}

declare const mermaid: DiagramApi;

function sizeSvg(svg: string) {
  const root = new DOMParser().parseFromString(
    svg,
    'image/svg+xml',
  ).documentElement;
  if (!(root instanceof SVGSVGElement)) return svg;
  const { width, height } = root.viewBox.baseVal;
  if (width > 0 && height > 0) {
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
  }
  return new XMLSerializer().serializeToString(root);
}

window.addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    const port = event.ports[0];
    const container = document.querySelector('main');
    if (
      event.source !== parent ||
      event.data !== 'markdown-diagram-preview' ||
      !port ||
      !container
    )
      return;

    let pending = Promise.resolve();
    port.onmessage = (message: MessageEvent<unknown>) => {
      const request = message.data;
      if (!request || typeof request !== 'object') return;
      if (
        !('id' in request) ||
        typeof request.id !== 'number' ||
        !('source' in request) ||
        typeof request.source !== 'string' ||
        !('dark' in request) ||
        typeof request.dark !== 'boolean'
      )
        return;
      const { id, source, dark } = request;
      pending = pending.then(async () => {
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            htmlLabels: false,
            suppressErrorRendering: true,
            theme: dark ? 'dark' : 'default',
            secure: [
              'secure',
              'securityLevel',
              'startOnLoad',
              'maxTextSize',
              'maxEdges',
              'suppressErrorRendering',
              'htmlLabels',
              'themeCSS',
            ],
          });
          const { svg } = await mermaid.render(
            'markdown-diagram-' + id,
            source,
            container,
          );
          port.postMessage({ id, svg: sizeSvg(svg) });
        } catch {
          port.postMessage({ id, svg: null });
        } finally {
          container.replaceChildren();
        }
      });
    };
    port.postMessage('ready');
  },
  { once: true },
);

/** V2 menu names come from the chosen row or frozen snapshot, never a service alias. */
export function modelDisplayLabel(model: {
  modelId: string;
  displayName?: string;
  modelDisplayName?: string;
}): string {
  return (
    model.modelDisplayName?.trim() || model.displayName?.trim() || model.modelId
  );
}

/** Service metadata belongs in a secondary caption or group heading. */
export function modelServiceCaption(service: {
  name?: string;
  provider?: string;
  serviceName?: string;
  protocol?: string;
}): string {
  const protocol =
    service.protocol === 'chatCompletions'
      ? 'Chat Completions'
      : service.protocol === 'responses'
        ? 'Responses'
        : service.protocol === 'anthropicMessages'
          ? 'Anthropic Messages'
          : service.provider;
  return [protocol, service.serviceName ?? service.name]
    .filter(Boolean)
    .join(' · ');
}

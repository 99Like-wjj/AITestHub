// Sibling portals do not inherit each other's Ant Design z-index context.
export const uiLayers = {
  drawer: 1000,
  detail: 1100,
  dialog: 1200,
  nestedDialog: 1400,
  confirmation: 1600,
  evidence: 1800,
} as const;

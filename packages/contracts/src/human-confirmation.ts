import { z } from 'zod';
import { sha256Schema } from './base.js';

export const humanConfirmationProposalSchema = z.strictObject({
  reason: z.enum([
    'precise-scope',
    'manual-overlap',
    'impact',
    'explicit-selection',
    'human-decision',
  ]),
  summary: z.string(),
  scope: z.json(),
  links: z.array(z.string()),
  digest: sha256Schema,
});

import type { MessageKey } from '../admin/i18n/messages.en';
import type { ConfigIssue } from '../customizer/models/config.models';
import type { ProductConfig } from '../customizer/models/product.models';

export interface SetupStep {
  id: 'mockup' | 'area' | 'artwork' | 'input' | 'valid';
  labelKey: MessageKey;
  hintKey: MessageKey;
  done: boolean;
}

/**
 * The guided setup the editor shows for a new configuration, and the conditions for publishing.
 * Every step is derived from the configuration itself; nothing is stored separately.
 */
export function setupSteps(
  config: ProductConfig,
  strictIssues: readonly ConfigIssue[],
): SetupStep[] {
  const placements = config.mockups.reduce((n, m) => n + m.placements.length, 0);
  const layers = config.artworks.reduce((n, a) => n + a.layers.length, 0);
  return [
    {
      id: 'mockup',
      labelKey: 'ready.mockup.label',
      hintKey: 'ready.mockup.hint',
      done: config.mockups.length > 0,
    },
    {
      id: 'area',
      labelKey: 'ready.area.label',
      hintKey: 'ready.area.hint',
      done: placements > 0,
    },
    {
      id: 'artwork',
      labelKey: 'ready.artwork.label',
      hintKey: 'ready.artwork.hint',
      done: layers > 0,
    },
    {
      id: 'input',
      labelKey: 'ready.input.label',
      hintKey: 'ready.input.hint',
      done: config.fields.length > 0,
    },
    {
      id: 'valid',
      labelKey: 'ready.valid.label',
      hintKey: 'ready.valid.hint',
      done: strictIssues.length === 0 && config.mockups.length > 0,
    },
  ];
}

export function canPublish(steps: readonly SetupStep[]): boolean {
  return steps.every((step) => step.done);
}

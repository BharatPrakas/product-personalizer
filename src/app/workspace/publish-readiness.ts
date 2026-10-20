import type { ConfigIssue } from '../customizer/models/config.models';
import type { ProductConfig } from '../customizer/models/product.models';

export interface SetupStep {
  id: 'mockup' | 'area' | 'artwork' | 'input' | 'valid';
  label: string;
  hint: string;
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
      label: 'Add a product photo',
      hint: 'Upload the mockup customers will see their design on.',
      done: config.mockups.length > 0,
    },
    {
      id: 'area',
      label: 'Define a printable area',
      hint: 'Draw where the print goes on the mockup.',
      done: placements > 0,
    },
    {
      id: 'artwork',
      label: 'Design the artwork',
      hint: 'Add layers to the artwork of a printable area.',
      done: layers > 0,
    },
    {
      id: 'input',
      label: 'Add a customer input',
      hint: 'A photo slot or editable text lets customers personalize.',
      done: config.fields.length > 0,
    },
    {
      id: 'valid',
      label: 'Resolve configuration problems',
      hint: 'Every variant needs a mockup and a printable area, and no problems may remain.',
      done: strictIssues.length === 0 && config.mockups.length > 0,
    },
  ];
}

export function canPublish(steps: readonly SetupStep[]): boolean {
  return steps.every((step) => step.done);
}

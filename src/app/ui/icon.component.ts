import { Component, computed, input } from '@angular/core';

/** Stroke icons on a 24 x 24 grid. Each icon is a list of SVG path commands. */
const ICONS = {
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  'chevron-down': ['M5 9l7 7 7-7'],
  'chevron-up': ['M5 15l7-7 7 7'],
  'arrow-left': ['M19 12H5M11 6l-6 6 6 6'],
  'arrow-up': ['M12 19V5M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14M6 13l6 6 6-6'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  grip: ['M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.2-4.2'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  redo: ['M15 14l5-5-5-5', 'M20 9H10a6 6 0 0 0 0 12h3'],
  save: ['M5 3h11l4 4v14H5z', 'M8 3v5h7V3', 'M8 21v-7h8v7'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  'eye-off': [
    'M2 12s3.5-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.2-1.5',
    'M4 4l16 16',
  ],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 7.5-2'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M8.5 8.5h.01'],
  text: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'],
  square: ['M5 5h14v14H5z'],
  circle: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  shapes: ['M4 4h8v8H4z', 'M17 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M6 20l3-5 3 5z'],
  layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  area: ['M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4', 'M9 9h6v6H9z'],
  artwork: ['M4 4h16v16H4z', 'M4 14l4-4 4 4 3-3 5 5', 'M16 8h.01'],
  mockup: ['M3 5h18v14H3z', 'M7 19l4-6 3 4 2-2 3 4'],
  preview: [
    'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ],
  play: ['M8 5v14l11-7z'],
  'zoom-in': ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.2-4.2', 'M11 8v6M8 11h6'],
  'zoom-out': ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.2-4.2', 'M8 11h6'],
  fit: ['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'],
  hand: [
    'M8 13V6.5a1.5 1.5 0 0 1 3 0V12',
    'M11 11V4.5a1.5 1.5 0 0 1 3 0V11',
    'M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2 6.5-6 6.5-3 0-4-1.5-5.5-4l-1.7-3a1.5 1.5 0 0 1 2.5-1.6L8 14',
  ],
  cursor: ['M5 3l14 8-6 2-2 6z'],
  upload: ['M12 16V4M7 9l5-5 5 5', 'M4 20h16'],
  download: ['M12 4v12M7 11l5 5 5-5', 'M4 20h16'],
  sliders: ['M4 7h10M18 7h2M4 17h2M10 17h10', 'M14 5v4M6 15v4'],
  alert: ['M12 4l9 16H3z', 'M12 10v4M12 17h.01'],
  info: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 11v5M12 8h.01'],
  'panel-left': ['M4 5h16v14H4z', 'M9 5v14'],
  'panel-right': ['M4 5h16v14H4z', 'M15 5v14'],
  rotate: ['M20 12a8 8 0 1 1-3-6.2', 'M20 4v5h-5'],
  archive: ['M4 5h16v4H4z', 'M6 9v10h12V9', 'M10 13h4'],
  file: ['M7 3h7l5 5v13H7z', 'M14 3v5h5'],
  clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4l3 2'],
  'circle-check': ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M8.5 12.5l2.5 2.5 4.5-5'],
  'circle-empty': ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  pen: ['M4 20l1-4L16 5l3 3L8 19z', 'M14 7l3 3'],
  vector: ['M5 5h3v3H5z', 'M16 16h3v3h-3z', 'M8 6.5C13 6.5 17.5 11 17.5 16', 'M5 19l3-3'],
  list: ['M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
} as const;

export type IconName = keyof typeof ICONS;

@Component({
  selector: 'app-icon',
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly size = input(18);
  protected readonly paths = computed(() => ICONS[this.name()]);
}

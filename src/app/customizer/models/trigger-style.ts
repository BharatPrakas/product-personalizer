/**
 * Public contract for how `<zb-product-customizer>` is rendered and how its trigger button is styled.
 * Compiled to `types/trigger-style.d.ts` by `npm run build:element`.
 */

/**
 * - `storefront`: a button that appears only when the product has a published template; the editor
 *   opens in a modal when it is clicked.
 * - `preview`: the editor is rendered inline, with no trigger (the admin live preview, configuration
 *   testing, and hosts that want the editor in the page).
 *
 * Absent (`null`), the element chooses: it is `storefront` when it resolves the template from
 * `product-id`, and `preview` when the host supplies `config` / `config-url` itself.
 */
export type ZbRenderMode = 'storefront' | 'preview';

/**
 * Appearance of the trigger button. The names and units are those of the ZenBasket Builder's button
 * model (`ButtonPropertiesModel`), so a Builder button can be passed as it is: numbers are pixels, a
 * `buttonTextFontStyle` entry is `'B'` (bold), `'I'` (italic) or `'U'` (underline), corner and side
 * lists use the Builder's `'TL' | 'TR' | 'BR' | 'BL'` and `'T' | 'R' | 'B' | 'L'` codes.
 *
 * Every field is optional and validated: a value that is not a plain colour, a bounded number or a
 * known keyword is ignored (the default applies), never written into CSS text. Unknown keys are ignored.
 * The modal editor is not affected by any of this; it keeps its own design.
 */
export interface ZbTriggerStyle {
  /** Label of the button (default `Personalize`; `Edit personalization` once a design is saved). Max 60 characters. */
  buttonText?: string;
  /** Background colour: hex, `rgb()/rgba()`, `hsl()/hsla()` or a colour name. */
  buttonColor?: string;
  /** Text colour. Replaced by black or white when it would be unreadable (below 4.5:1) on `buttonColor`. */
  buttonTextColor?: string;
  /** Font family or comma separated list, e.g. `Roboto, sans-serif`. Letters, digits, spaces, `-` and `_` only. */
  buttonFont?: string;
  /** Font size in px (8–72). */
  buttonTextSize?: number;
  /** `'B'` bold, `'I'` italic, `'U'` underline. */
  buttonTextFontStyle?: readonly string[];
  /** Corner radius in px (0–100). */
  buttonRadius?: number;
  /** Corners the radius applies to; all when absent or empty. */
  borderRadiusPositions?: readonly string[];
  /** Vertical padding in px (0–64). */
  buttonPadding?: number;
  /** Horizontal padding in px (0–96); twice `buttonPadding` when absent. */
  buttonPaddingInline?: number;
  /** Width in px (40–1200), or `'full'` for the full width of the slot. Fits the content when absent. */
  width?: number | 'full';
  /** `'start' | 'center' | 'end'` (also `'left'` / `'right'`): where the button sits in its slot. */
  buttonAlignment?: string;
  /** Border colour. */
  buttonBorderColor?: string;
  /** Border thickness in px (0–12). */
  buttonBorderThickness?: number;
  /** Sides the border is drawn on; all when absent or empty. */
  buttonBorderPositions?: readonly string[];
  /** `'solid' | 'dashed' | 'dotted' | 'double'`. */
  borderStyle?: string;
  /** The hover colours apply unless this is `false`. */
  isButtonHoverEffect?: boolean;
  buttonHoverColor?: string;
  buttonHoverTextColor?: string;
  buttonBorderHoverColor?: string;
  /** Appearance while the element is `disabled` (not in the Builder yet; names follow its convention). */
  buttonDisabledColor?: string;
  buttonDisabledTextColor?: string;
  buttonDisabledBorderColor?: string;
}

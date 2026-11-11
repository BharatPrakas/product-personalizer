/**
 * Pure mapping from what the storefront saved (`customizations.data`, see `prepareForCart` in
 * product-customizer.component.ts) plus the pinned template version to what the Orders detail page
 * shows. Everything is defensive: `data` is shopper-submitted JSON, the template version may no
 * longer be readable, and files may be gone. Unknown labels fall back to the raw ids.
 */

import type { ProductConfig } from '../customizer/models/product.models';
import type { CropRect, PriceSnapshot } from '../customizer/models/draft.models';
import type { OrderAsset, OrderAssetKind, OrderLine, OrderListLine, OrderSummary } from './order.models';

// ---- the saved design -------------------------------------------------------------------------

export interface SavedUploadRef {
  /** The id the design uses for the photo (`ImageValue.assetId`). */
  localId: string;
  /** The stored file. */
  ref: string | null;
}

export interface SavedArtworkRef {
  printableAreaId: string;
  artworkId: string | null;
  width: number | null;
  height: number | null;
  ref: string | null;
}

export interface SavedPreviewRef {
  mockupId: string;
  ref: string | null;
}

export interface SavedDesign {
  templateId: string | null;
  templateVersion: number | null;
  variantId: string | null;
  values: Record<string, unknown>;
  artworkSelection: Record<string, string>;
  displayPrice: PriceSnapshot | null;
  uploads: SavedUploadRef[];
  artworks: SavedArtworkRef[];
  previews: SavedPreviewRef[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);

function readPrice(v: unknown): PriceSnapshot | null {
  if (!isObject(v)) return null;
  const currency = str(v['currency']);
  const exponent = num(v['exponent']);
  const total = num(v['totalMinor']);
  if (!currency || exponent === null || total === null) return null;
  return {
    currency,
    exponent,
    baseMinor: num(v['baseMinor']) ?? 0,
    customizationFeeMinor: num(v['customizationFeeMinor']) ?? 0,
    totalMinor: total,
    authoritative: false,
  };
}

/** Reads `customizations.data` (envelope `{ schema: 1, template, customization, files }`). */
export function readSavedDesign(data: unknown): SavedDesign {
  const root = isObject(data) ? data : {};
  // Older / foreign saves may put the customization at the root.
  const c = isObject(root['customization']) ? root['customization'] : root;
  const template = isObject(root['template']) ? root['template'] : {};
  const files = isObject(root['files']) ? root['files'] : {};
  const selection = isObject(c['artworkSelection']) ? c['artworkSelection'] : {};
  return {
    templateId: str(template['id']) ?? str(c['configId']) ?? str(c['templateId']),
    templateVersion: num(template['version']) ?? num(c['configVersion']) ?? num(c['templateVersion']),
    variantId: str(c['variantId']),
    values: isObject(c['values']) ? c['values'] : {},
    artworkSelection: Object.fromEntries(
      Object.entries(selection).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    displayPrice: readPrice(c['displayPrice']),
    uploads: list(files['uploads'])
      .map((u) => ({ localId: str(u['assetId']) ?? '', ref: str(u['ref']) }))
      .filter((u) => u.localId),
    artworks: list(files['artworks'])
      .map((a) => ({
        printableAreaId: str(a['printableAreaId']) ?? '',
        artworkId: str(a['artworkId']),
        width: num(a['width']),
        height: num(a['height']),
        ref: str(a['ref']),
      }))
      .filter((a) => a.printableAreaId),
    previews: list(files['previews'])
      .map((p) => ({ mockupId: str(p['mockupId']) ?? '', ref: str(p['ref']) }))
      .filter((p) => p.mockupId),
  };
}

// ---- customer inputs ------------------------------------------------------------------------------

export type InputView =
  | {
      kind: 'text';
      fieldId: string;
      label: string;
      text: string;
      font: string | null;
      color: string | null;
      styles: string[];
    }
  | {
      kind: 'image';
      fieldId: string;
      label: string;
      /** The stored upload, when it can be matched. */
      assetId: string | null;
      crop: CropRect | null;
      fit: string | null;
      rotation: number;
    }
  | { kind: 'choice'; fieldId: string; label: string; value: string | null }
  | { kind: 'design'; fieldId: string; label: string; value: string };

/**
 * Every value the shopper submitted, in the template's field order when the pinned version is known
 * (else in saved order), labelled from that version. Then the artwork chosen per printable area.
 */
export function customerInputs(design: SavedDesign, config: ProductConfig | null): InputView[] {
  const fields = new Map((config?.fields ?? []).map((f) => [f.id, f]));
  const fonts = new Map((config?.fonts ?? []).map((f) => [f.id, f.label ?? f.family]));
  const uploads = new Map(design.uploads.map((u) => [u.localId, u.ref]));
  const order = [
    ...(config?.fields ?? []).map((f) => f.id).filter((id) => id in design.values),
    ...Object.keys(design.values).filter((id) => !fields.has(id)),
  ];
  const out: InputView[] = [];
  for (const fieldId of order) {
    const value = design.values[fieldId];
    if (!isObject(value)) continue;
    const field = fields.get(fieldId);
    const label = field?.label || fieldId;
    if (typeof value['text'] === 'string') {
      const fontId = str(value['fontId']);
      out.push({
        kind: 'text',
        fieldId,
        label,
        text: value['text'],
        font: fontId ? (fonts.get(fontId) ?? fontId) : null,
        color: str(value['color']),
        styles: (['bold', 'italic', 'underline'] as const).filter((s) => value[s] === true),
      });
    } else if ('assetId' in value || 'crop' in value) {
      const localId = str(value['assetId']);
      const crop = Array.isArray(value['crop']) && value['crop'].length === 4 && value['crop'].every((n) => typeof n === 'number')
        ? (value['crop'] as unknown as CropRect)
        : null;
      out.push({
        kind: 'image',
        fieldId,
        label,
        assetId: localId ? (uploads.get(localId) ?? null) : null,
        crop,
        fit: str(value['fit']),
        rotation: num(value['rotation']) ?? 0,
      });
    } else if ('choiceId' in value) {
      const choiceId = str(value['choiceId']);
      const choice = field?.type === 'artwork' ? field.choices.find((c) => c.id === choiceId) : undefined;
      out.push({ kind: 'choice', fieldId, label, value: choice?.label ?? choiceId });
    }
  }
  const areas = new Map((config?.printableAreas ?? []).map((a) => [a.id, a.name]));
  const artworks = new Map((config?.artworks ?? []).map((a) => [a.id, a.name]));
  for (const [areaId, artworkId] of Object.entries(design.artworkSelection)) {
    out.push({
      kind: 'design',
      fieldId: areaId,
      label: areas.get(areaId) ?? areaId,
      value: artworks.get(artworkId) ?? artworkId,
    });
  }
  return out;
}

/** `PriceSnapshot` amounts as numbers in major units. */
export function priceOf(snapshot: PriceSnapshot): { base: number; fee: number; total: number } {
  const scale = 10 ** snapshot.exponent;
  return {
    base: snapshot.baseMinor / scale,
    fee: snapshot.customizationFeeMinor / scale,
    total: snapshot.totalMinor / scale,
  };
}

// ---- files ----------------------------------------------------------------------------------------

export type FileGroup = 'production' | 'previews' | 'uploads';

export interface FileView {
  group: FileGroup;
  kind: OrderAssetKind;
  /** Area / mockup / field name, or the raw id. */
  label: string;
  /** `null`: the design references a file that is no longer stored. */
  asset: OrderAsset | null;
  width: number | null;
  height: number | null;
}

const GROUP_OF: Record<OrderAssetKind, FileGroup> = { artwork: 'production', preview: 'previews', upload: 'uploads' };

/**
 * One entry per file of a line: every stored asset, labelled from the design's file references and
 * the pinned template, plus a "missing" entry for each reference whose file is gone.
 */
export function lineFiles(line: OrderLine, design: SavedDesign | null, config: ProductConfig | null): FileView[] {
  const byId = new Map(line.assets.map((a) => [a.assetId, a]));
  const areas = new Map((config?.printableAreas ?? []).map((a) => [a.id, a.name]));
  const mockups = new Map((config?.mockups ?? []).map((m) => [m.id, m.name]));
  const uploadLabels = new Map<string, string>();
  if (design) {
    for (const input of customerInputs(design, config)) {
      if (input.kind === 'image' && input.assetId) uploadLabels.set(input.assetId, input.label);
    }
  }
  const used = new Set<string>();
  const out: FileView[] = [];
  const add = (kind: OrderAssetKind, ref: string | null, label: string, size?: { width: number | null; height: number | null }) => {
    const asset = ref ? (byId.get(ref) ?? null) : null;
    if (asset) used.add(asset.assetId);
    out.push({
      group: GROUP_OF[kind],
      kind,
      label,
      asset,
      width: asset?.width ?? size?.width ?? null,
      height: asset?.height ?? size?.height ?? null,
    });
  };
  for (const a of design?.artworks ?? []) add('artwork', a.ref, areas.get(a.printableAreaId) ?? a.printableAreaId, a);
  for (const p of design?.previews ?? []) add('preview', p.ref, mockups.get(p.mockupId) ?? p.mockupId);
  for (const u of design?.uploads ?? []) add('upload', u.ref, (u.ref && uploadLabels.get(u.ref)) || u.localId);
  // Stored files the design does not reference (older save formats): label them by what we know.
  for (const asset of line.assets) {
    if (used.has(asset.assetId)) continue;
    const named = asset.filename ?? asset.assetId;
    const label = asset.kind === 'artwork' ? (areas.get(named) ?? named) : asset.kind === 'preview' ? (mockups.get(named) ?? named) : named;
    add(asset.kind, asset.assetId, label);
  }
  return out;
}

// ---- list -----------------------------------------------------------------------------------------

/** The status badge of an order: `expired` when any line's design expired, else `ordered`. */
export function orderStatus(order: Pick<OrderSummary, 'lines'>): 'ordered' | 'expired' {
  return order.lines.some((l) => l.status === 'expired') ? 'expired' : 'ordered';
}

/** Distinct line titles (or product ids) for the list's product column. */
export function productNames(lines: readonly OrderListLine[]): string[] {
  return [...new Set(lines.map((l) => l.title ?? l.productId))];
}

/**
 * The next list state after loading a page: a first page replaces, a "load more" page appends —
 * dropping orders already shown (a new order linked between pages can shift a boundary).
 */
export function mergePage(current: readonly OrderSummary[], page: readonly OrderSummary[], append: boolean): OrderSummary[] {
  if (!append) return [...page];
  const seen = new Set(current.map((o) => o.orderId));
  return [...current, ...page.filter((o) => !seen.has(o.orderId))];
}

/** Local calendar day bounds (from an `<input type="date">` value) as ISO instants for the API. */
export function dayBounds(from: string, to: string): { from?: string; to?: string } {
  const parse = (v: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] as const : null;
  };
  const out: { from?: string; to?: string } = {};
  const f = parse(from);
  const t = parse(to);
  if (f) out.from = new Date(f[0], f[1], f[2], 0, 0, 0, 0).toISOString();
  if (t) out.to = new Date(t[0], t[1], t[2], 23, 59, 59, 999).toISOString();
  return out;
}

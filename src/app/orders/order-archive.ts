/**
 * What goes where in a download archive. Pure: the plan lists paths and where each file's bytes come
 * from; `OrderDownloads` fetches them and `createZip` packs them.
 *
 *   order-<orderId>-line-<lineId>.zip
 *     production/<area name>.png      print-ready artwork, one per printable area
 *     previews/<mockup name>.png      product previews
 *     uploads/<upload name>.<ext>     the shopper's photos
 *     customization.json              the saved design plus order-line metadata
 *
 *   order-<orderId>.zip               the same, one `line-<lineId>/` folder per line
 *
 * `customization.json` carries order/line identifiers only — no customer name, email, phone or
 * address — so a production file shared with a print shop does not spread personal data.
 */

import type { ProductConfig } from '../customizer/models/product.models';
import { UniqueNames, extensionFor, fileName, sanitizeSegment } from './filenames';
import type { MerchantCustomization, OrderDetail, OrderLine } from './order.models';
import { lineFiles, type FileGroup, type FileView } from './order-view';
import type { SavedDesign } from './order-view';

export type ArchiveSource =
  | { kind: 'asset'; customizationId: string; assetId: string }
  | { kind: 'json'; value: unknown };

export interface ArchiveEntry {
  path: string;
  /** Human-readable name for progress and failure messages. */
  label: string;
  source: ArchiveSource;
}

/** A file the design references but that is no longer stored: reported, never fetched. */
export interface MissingFile {
  path: string;
  label: string;
}

export interface ArchivePlan {
  filename: string;
  entries: ArchiveEntry[];
  missing: MissingFile[];
}

export interface LineSource {
  line: OrderLine;
  customization: MerchantCustomization | null;
  design: SavedDesign | null;
  config: ProductConfig | null;
}

const FOLDERS: Record<FileGroup, string> = { production: 'production', previews: 'previews', uploads: 'uploads' };

export function lineArchiveName(orderId: string, lineId: string): string {
  return `order-${sanitizeSegment(orderId, 'order')}-line-${sanitizeSegment(lineId, 'line')}.zip`;
}

export function orderArchiveName(orderId: string): string {
  return `order-${sanitizeSegment(orderId, 'order')}.zip`;
}

/** The file name a single downloaded file gets (outside an archive). */
export function singleFileName(order: Pick<OrderDetail, 'orderId'>, line: OrderLine, file: FileView): string {
  const ext = file.asset ? extensionFor(file.asset.contentType) : 'bin';
  return fileName(
    `order-${order.orderId}-line-${line.lineId}-${file.group}-${file.label}`,
    ext,
    'file',
  );
}

function snapshot(order: OrderDetail, source: LineSource): unknown {
  const { line, customization } = source;
  return {
    order: { orderId: order.orderId, orderNumber: order.orderNumber, placedAt: order.placedAt, currency: order.currency },
    line: {
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    },
    customization: {
      id: line.customization.id,
      status: line.customization.status,
      configId: line.customization.configId,
      configVersion: line.customization.configVersion,
    },
    data: customization?.data ?? null,
  };
}

/** Entries of one line, under `prefix` (empty for a per-line archive, `line-<id>/` inside an order archive). */
function lineEntries(order: OrderDetail, source: LineSource, prefix: string): { entries: ArchiveEntry[]; missing: MissingFile[] } {
  const names: Record<FileGroup, UniqueNames> = { production: new UniqueNames(), previews: new UniqueNames(), uploads: new UniqueNames() };
  const entries: ArchiveEntry[] = [];
  const missing: MissingFile[] = [];
  for (const file of lineFiles(source.line, source.design, source.config)) {
    const ext = file.asset ? extensionFor(file.asset.contentType) : 'png';
    const path = `${prefix}${FOLDERS[file.group]}/${names[file.group].claim(fileName(file.label, ext, file.kind))}`;
    if (!file.asset) {
      missing.push({ path, label: file.label });
      continue;
    }
    entries.push({
      path,
      label: file.label,
      source: { kind: 'asset', customizationId: source.line.customization.id, assetId: file.asset.assetId },
    });
  }
  entries.push({ path: `${prefix}customization.json`, label: 'customization.json', source: { kind: 'json', value: snapshot(order, source) } });
  return { entries, missing };
}

export function lineArchive(order: OrderDetail, source: LineSource): ArchivePlan {
  return { filename: lineArchiveName(order.orderId, source.line.lineId), ...lineEntries(order, source, '') };
}

export function orderArchive(order: OrderDetail, sources: readonly LineSource[]): ArchivePlan {
  const folders = new UniqueNames();
  const plan: ArchivePlan = { filename: orderArchiveName(order.orderId), entries: [], missing: [] };
  for (const source of sources) {
    const folder = folders.claim(`line-${sanitizeSegment(source.line.lineId, 'line')}`);
    const { entries, missing } = lineEntries(order, source, `${folder}/`);
    plan.entries.push(...entries);
    plan.missing.push(...missing);
  }
  return plan;
}

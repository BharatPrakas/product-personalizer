import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ImageFieldSpec } from '../models/config.models';
import { FieldError } from '../models/draft.models';
import { MAX_ZOOM, MIN_ZOOM, cropToPixels } from '../util/crop-math';
import { PhotoView } from '../services/state.service';

const CROP_CANVAS_EDGE = 480;
/** Keyboard / button nudge as a fraction of the visible crop. */
const NUDGE = 0.05;

export interface PanEvent {
  dx: number;
  dy: number;
}

/** Photo upload with a fixed-aspect crop editor: pan, zoom, directional buttons, reset, remove. */
@Component({
  selector: 'app-photo-field',
  imports: [ReactiveFormsModule],
  template: `
    <fieldset
      class="field"
      [disabled]="disabled()"
      [attr.aria-describedby]="field().helpText ? id('help') : null"
    >
      <legend class="label">
        {{ field().label }}
        @if (field().required) {
          <span class="req">(required)</span>
        }
      </legend>
      @if (field().helpText) {
        <p class="help" [id]="id('help')">{{ field().helpText }}</p>
      }

      @if (view(); as photo) {
        <div class="crop">
          <canvas
            #crop
            class="crop-canvas"
            tabindex="0"
            role="img"
            aria-label="Photo crop. Drag to move the photo, or focus and use the arrow keys; plus and minus zoom."
            [style.aspect-ratio]="photo.aspect"
            (pointerdown)="dragStart($event)"
            (pointermove)="dragMove($event)"
            (pointerup)="dragEnd($event)"
            (pointercancel)="dragEnd($event)"
            (keydown)="onKey($event, photo.zoom)"
          ></canvas>

          <div class="crop-controls">
            <label class="label sub" [for]="id('zoom')">Zoom</label>
            <input
              class="range"
              type="range"
              [id]="id('zoom')"
              [min]="minZoom"
              [max]="maxZoom"
              step="0.01"
              [formControl]="zoom"
              [attr.aria-valuetext]="photo.zoom.toFixed(1) + ' times'"
            />

            <div class="dpad" role="group" aria-label="Move photo">
              <button
                type="button"
                class="btn icon dpad-up"
                aria-label="Move photo up"
                (click)="pan.emit({ dx: 0, dy: -nudge })"
              >
                ▲
              </button>
              <button
                type="button"
                class="btn icon dpad-left"
                aria-label="Move photo left"
                (click)="pan.emit({ dx: -nudge, dy: 0 })"
              >
                ◀
              </button>
              <button
                type="button"
                class="btn icon dpad-right"
                aria-label="Move photo right"
                (click)="pan.emit({ dx: nudge, dy: 0 })"
              >
                ▶
              </button>
              <button
                type="button"
                class="btn icon dpad-down"
                aria-label="Move photo down"
                (click)="pan.emit({ dx: 0, dy: nudge })"
              >
                ▼
              </button>
            </div>

            <div class="btn-row">
              <button type="button" class="btn secondary" (click)="resetCrop.emit()">
                Reset crop
              </button>
              <label class="btn secondary file-btn">
                <span>Replace photo</span>
                <input
                  type="file"
                  class="file-input"
                  accept="image/png,image/jpeg"
                  (change)="onFile($event)"
                />
              </label>
              <button type="button" class="btn secondary" (click)="remove.emit()">
                Remove photo
              </button>
            </div>
          </div>
        </div>
      } @else {
        <label class="btn secondary file-btn upload-btn">
          <span>{{ busy() ? 'Processing…' : 'Upload photo' }}</span>
          <input
            type="file"
            class="file-input"
            accept="image/png,image/jpeg"
            [attr.aria-describedby]="id('hint')"
            (change)="onFile($event)"
            (blur)="blurred.emit()"
          />
        </label>
        <p class="help" [id]="id('hint')">
          PNG or JPEG, up to 10 MB. The photo stays in your browser until you save.
        </p>
      }

      @if (busy()) {
        <p class="status-line" role="status">
          <span class="spinner" aria-hidden="true"></span> Processing photo…
        </p>
      }
      @if (view()?.resolution; as res) {
        <p class="help" [class.help-warn]="res.level !== 'ok'">
          Print resolution: about {{ res.dpi.toFixed(0) }} DPI.
        </p>
      }
      <div class="errors" aria-live="polite">
        @if (uploadError()) {
          <p class="error">
            <span class="error-mark" aria-hidden="true">!</span> {{ uploadError() }}
          </p>
        }
        @for (error of errors(); track error.code) {
          <p class="error">
            <span class="error-mark" aria-hidden="true">!</span> {{ error.message }}
          </p>
        }
        @for (warning of warnings(); track warning) {
          <p class="warning">
            <span class="warning-mark" aria-hidden="true">i</span> {{ warning }}
          </p>
        }
      </div>
    </fieldset>
  `,
})
export class PhotoFieldComponent {
  readonly field = input.required<ImageFieldSpec>();
  readonly view = input<PhotoView | null>(null);
  readonly busy = input(false);
  readonly uploadError = input<string | null>(null);
  readonly errors = input.required<readonly FieldError[]>();
  readonly warnings = input<readonly string[]>([]);
  readonly disabled = input(false);

  readonly file = output<File>();
  readonly pan = output<PanEvent>();
  readonly zoomTo = output<number>();
  readonly resetCrop = output<void>();
  readonly remove = output<void>();
  readonly blurred = output<void>();

  protected readonly minZoom = MIN_ZOOM;
  protected readonly maxZoom = MAX_ZOOM;
  protected readonly nudge = NUDGE;
  protected readonly zoom = new FormControl(MIN_ZOOM, { nonNullable: true });

  private readonly cropCanvas = viewChild<ElementRef<HTMLCanvasElement>>('crop');
  private drag: { id: number; x: number; y: number } | null = null;

  constructor() {
    effect(() => {
      const zoom = this.view()?.zoom;
      if (zoom !== undefined && Math.abs(this.zoom.value - zoom) > 1e-6)
        this.zoom.setValue(zoom, { emitEvent: false });
    });
    this.zoom.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => this.zoomTo.emit(value));

    effect(() => {
      const view = this.view();
      const canvas = this.cropCanvas()?.nativeElement;
      if (!view || !canvas) return;
      const width =
        view.aspect >= 1 ? CROP_CANVAS_EDGE : Math.round(CROP_CANVAS_EDGE * view.aspect);
      const height =
        view.aspect >= 1 ? Math.round(CROP_CANVAS_EDGE / view.aspect) : CROP_CANVAS_EDGE;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { sx, sy, sw, sh } = cropToPixels(view.crop, view.width, view.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(view.bitmap, sx, sy, sw, sh, 0, 0, width, height);
    });
  }

  protected id(part: string): string {
    return `f-${this.field().id}-${part}`;
  }

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    this.blurred.emit();
    if (chosen) this.file.emit(chosen);
  }

  protected dragStart(event: PointerEvent): void {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  protected dragMove(event: PointerEvent): void {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // The canvas shows exactly the crop, so a drag of N% of its size moves the window by N% of the crop.
    this.pan.emit({
      dx: -(event.clientX - this.drag.x) / rect.width,
      dy: -(event.clientY - this.drag.y) / rect.height,
    });
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  protected dragEnd(event: PointerEvent): void {
    if (this.drag?.id === event.pointerId) this.drag = null;
  }

  protected onKey(event: KeyboardEvent, zoom: number): void {
    const moves: Record<string, PanEvent> = {
      ArrowLeft: { dx: -NUDGE, dy: 0 },
      ArrowRight: { dx: NUDGE, dy: 0 },
      ArrowUp: { dx: 0, dy: -NUDGE },
      ArrowDown: { dx: 0, dy: NUDGE },
    };
    const move = moves[event.key];
    if (move) {
      this.pan.emit(move);
    } else if (event.key === '+' || event.key === '=') {
      this.zoomTo.emit(zoom * 1.1);
    } else if (event.key === '-') {
      this.zoomTo.emit(zoom / 1.1);
    } else {
      return;
    }
    event.preventDefault();
  }
}

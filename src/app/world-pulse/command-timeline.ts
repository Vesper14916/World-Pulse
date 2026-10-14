import type { PulseEvent } from '../../../shared/world-pulse';
import type { MaritimeSnapshot, TimelineSnapshot } from '../../../shared/world-pulse-command';
import { eventTime, COMMAND_RETENTION_MS } from '../../../shared/world-pulse-command';
import { button, date, el } from './dom';

/** A retrospective browser over retained observations, never a claim of complete history. */
export class CommandTimeline {
  readonly element = el('section', {
    class: 'command-timeline',
    'aria-label': 'Observation timeline',
  });
  private input = el('input', { type: 'range', 'aria-label': 'Replay time', step: 60000 });
  private label = el('span', { class: 'timeline-time' });
  private bars = el('div', {
    class: 'timeline-bars',
    'aria-label': 'Event and AIS coverage by time',
  });
  private coverage = el('span', { class: 'timeline-coverage' });
  private play = button('▶ Replay', () => this.togglePlay(), 'timeline-play');
  private liveButton = button('Return to now', () => this.live(), 'timeline-live');
  private cursor: number | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private expanded = true;
  constructor(
    private hours: () => number,
    private change: () => void,
  ) {
    this.input.addEventListener('input', () => {
      this.pause();
      this.cursor = Number(this.input.value);
      this.change();
      this.updateTime();
    });
    this.element.append(
      el(
        'div',
        { class: 'timeline-header' },
        el('span', { class: 'eyebrow' }, 'TIME / OBSERVATION REPLAY'),
        this.label,
        button(
          'Collapse',
          () => {
            this.expanded = !this.expanded;
            this.element.classList.toggle('collapsed', !this.expanded);
            this.element.querySelector<HTMLButtonElement>('.timeline-collapse')!.textContent = this
              .expanded
              ? 'Collapse'
              : 'Expand';
          },
          'timeline-collapse',
          { 'aria-label': 'Toggle timeline' },
        ),
      ),
      el('div', { class: 'timeline-track' }, this.bars, this.input),
      el('div', { class: 'timeline-controls' }, this.play, this.liveButton, this.coverage),
      el(
        'p',
        { class: 'timeline-explainer' },
        'Retained reports & sampled AIS · shaded gaps have no collection record · late reports may appear retrospectively.',
      ),
    );
    this.update([], undefined, undefined);
  }
  get at() {
    return this.cursor;
  }
  get time() {
    return this.cursor ?? Date.now();
  }
  live() {
    this.pause();
    this.cursor = null;
    this.change();
    this.updateTime();
  }
  pause() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.play.textContent = '▶ Replay';
  }
  private togglePlay() {
    if (this.timer) {
      this.pause();
      return;
    }
    if (this.cursor === null) this.cursor = Date.now() - this.hours() * 3600000 + 1000;
    this.play.textContent = 'Ⅱ Pause';
    this.change();
    this.timer = setInterval(() => {
      if (document.hidden) {
        this.pause();
        return;
      }
      this.cursor = Math.min(
        Date.now(),
        (this.cursor || Date.now()) + Math.max(60000, (this.hours() * 3600000) / 120),
      );
      if (this.cursor >= Date.now() - 1000) {
        this.live();
        return;
      }
      this.change();
      this.updateTime();
    }, 1000);
  }
  update(
    events: PulseEvent[],
    coverage: MaritimeSnapshot['coverage'] | undefined,
    timeline: TimelineSnapshot | undefined,
  ) {
    const now = Date.now(),
      start = now - this.hours() * 3600000 + 1000;
    this.input.min = String(start);
    this.input.max = String(now);
    if (this.cursor !== null && this.cursor < Math.max(start, now - COMMAND_RETENTION_MS + 1000)) {
      this.cursor = Math.max(start, now - COMMAND_RETENTION_MS + 1000);
    }
    this.updateTime();
    const count = 48,
      step = (now - start) / count;
    const samples = Array.from({ length: count }, () => ({ events: 0, ships: 0, covered: false }));
    for (const e of events) {
      const i = Math.floor((eventTime(e) - start) / step);
      if (i >= 0 && i < count) samples[i]!.events++;
    }
    for (const bin of timeline?.bins || []) {
      const i = Math.floor((Date.parse(bin.at) - start) / step);
      if (i >= 0 && i < count) samples[i]!.ships += bin.samples;
    }
    if (coverage?.start && coverage.end) {
      const first = Date.parse(coverage.start),
        last = Date.parse(coverage.end);
      for (let i = 0; i < count; i++) {
        const t = start + i * step;
        samples[i]!.covered =
          t + step > first &&
          t < last &&
          !coverage.gaps.some(([a, b]) => t >= Date.parse(a) && t < Date.parse(b));
      }
    }
    const max = Math.max(1, ...samples.map((s) => s.events));
    this.bars.replaceChildren(
      ...samples.map((s, i) =>
        el(
          'span',
          {
            class: `timeline-bin ${s.covered ? 'covered' : 'gap'}`,
            title: `${date(new Date(start + i * step).toISOString())} · ${s.events} retained reports · ${s.ships} AIS samples`,
            style: `--bar:${Math.max(3, (s.events / max) * 26)}px`,
          },
          el('i'),
        ),
      ),
    );
    this.coverage.textContent = coverage?.start
      ? `AIS collection: ${date(coverage.start)} → ${date(coverage.end)}${coverage.capacityLimited ? ' · shortened by storage cap' : ''}`
      : 'No AIS collection history for this area';
  }
  private updateTime() {
    this.label.textContent =
      this.cursor === null ? 'NOW · Beijing time' : date(new Date(this.cursor).toISOString());
    this.label.classList.toggle('replaying', this.cursor !== null);
    this.input.value = String(this.cursor ?? Date.now());
    this.liveButton.disabled = this.cursor === null;
  }
}
